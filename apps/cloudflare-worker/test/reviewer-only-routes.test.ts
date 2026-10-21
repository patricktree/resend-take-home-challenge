import { test } from "vitest";
import { z } from "zod";

import { LOCAL_AGENT_TOKEN } from "@resend-challenge/api.routes";

import { useWorker } from "./use-worker.ts";

const UNKNOWN_IDS: Record<string, string> = {
  draftId: "drf_00000000-0000-7000-8000-000000000000",
  revisionId: "rev_00000000-0000-7000-8000-000000000000",
};

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options"]);

/** The part of the OpenAPI document this test reads: each operation's id and security. */
const openApiPathsSchema = z.object({
  paths: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({
        operationId: z.string().optional(),
        security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
      }),
    ),
  ),
});

test("exactly the approval and rejection routes are Reviewer-only: OpenAPI lists only reviewerAuth on them, and the Agent token gets 403 REVIEWER_ONLY there and nowhere else", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const documentResponse = await worker.fetch("/api/openapi.json");
  const document = openApiPathsSchema.parse(await documentResponse.json());

  const routes = Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );
  const observed = await Promise.all(
    routes.map(async ({ path, method, operation }) => {
      const url = path.replaceAll(/\{(\w+)\}/g, (_, name: string) => UNKNOWN_IDS[name] ?? name);
      const response = await worker.fetch(url, {
        method: method.toUpperCase(),
        headers: { Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` },
      });
      const body: unknown = await response.json();
      return {
        operationId: operation.operationId,
        security: operation.security,
        isRefusedAsReviewerOnly:
          response.status === 403 &&
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "object" &&
          body.error !== null &&
          "code" in body.error &&
          body.error.code === "REVIEWER_ONLY",
      };
    }),
  );

  const reviewerOnly = { security: [{ reviewerAuth: [] }], isRefusedAsReviewerOnly: true };
  const agentOrReviewer = {
    security: [{ agentAuth: [] }, { reviewerAuth: [] }],
    isRefusedAsReviewerOnly: false,
  };
  expect(observed.length).toBeGreaterThanOrEqual(7);
  expect(observed).toStrictEqual(
    observed.map(({ operationId }) => ({
      operationId,
      ...(operationId === "approveRevision" || operationId === "rejectRevision"
        ? reviewerOnly
        : agentOrReviewer),
    })),
  );
  expect(observed.filter((route) => route.isRefusedAsReviewerOnly)).toHaveLength(2);
});
