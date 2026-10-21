import { test } from "vitest";
import { z } from "zod";

import { useWorker } from "#test/use-worker.ts";

/** The parts of an OpenAPI document the tests read. */
const openApiDocumentSchema = z.object({
  paths: z.record(
    z.string(),
    z.object({ post: z.object({ responses: z.record(z.string(), z.unknown()) }).optional() }),
  ),
});

test("the published OpenAPI document matches the committed snapshot", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/openapi.json");

  expect(response.status).toBe(200);
  const document: unknown = await response.json();
  // Update the snapshot with `pnpm --filter '@resend-challenge/cloudflare-worker' test -u`.
  await expect(`${JSON.stringify(document, undefined, 2)}\n`).toMatchFileSnapshot(
    "./__snapshots__/openapi.json",
  );
});

test("every POST operation lists 413 PAYLOAD_TOO_LARGE: the 128 KB body limit guards each, also those that take no body", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/openapi.json");

  const document = openApiDocumentSchema.parse(await response.json());
  const postOperationsWithout413 = Object.entries(document.paths).flatMap(([path, operations]) =>
    operations.post !== undefined && !("413" in operations.post.responses) ? [path] : [],
  );
  expect(postOperationsWithout413).toStrictEqual([]);
  expect(Object.values(document.paths).filter(({ post }) => post !== undefined)).toHaveLength(5);
});

test("the OpenAPI document is OpenAPI 3.1 and declares both bearer schemes", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/openapi.json");

  expect(await response.json()).toMatchObject({
    openapi: "3.1.0",
    components: {
      securitySchemes: {
        agentAuth: { type: "http", scheme: "bearer" },
        reviewerAuth: { type: "http", scheme: "bearer" },
      },
    },
  });
});
