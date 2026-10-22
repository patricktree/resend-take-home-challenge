import { test } from "vitest";

import { LOCAL_AGENT_TOKEN, unsubmittedDraftSummarySchema } from "@resend-challenge/api.routes";

import { useWorker } from "./use-worker.ts";

const AUTHORIZATION = { Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` };

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Hello",
  body: { plainText: "Hello Ada" },
};

test("a write returns a read bookmark", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: { ...AUTHORIZATION, "Content-Type": "application/json" },
    body: JSON.stringify(DRAFT_DATA),
  });

  expect(response.status).toBe(201);
  expect(response.headers.get("X-Read-Bookmark")).toMatch(/^\S+$/);
});

test("a read with the bookmark of a write reads that write and returns a read bookmark", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const createResponse = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: { ...AUTHORIZATION, "Content-Type": "application/json" },
    body: JSON.stringify(DRAFT_DATA),
  });
  const created = unsubmittedDraftSummarySchema.parse(await createResponse.json());
  const writeBookmark = createResponse.headers.get("X-Read-Bookmark") ?? "";

  const response = await worker.fetch(`/api/v1/drafts/${created.id}`, {
    headers: { ...AUTHORIZATION, "X-Read-Bookmark": writeBookmark },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: created.id });
  expect(response.headers.get("X-Read-Bookmark")).toMatch(/^\S+$/);
});

test("a read without a bookmark returns a read bookmark", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/drafts/drf_00000000-0000-7000-8000-000000000000", {
    headers: AUTHORIZATION,
  });

  expect(response.status).toBe(404);
  expect(response.headers.get("X-Read-Bookmark")).toMatch(/^\S+$/);
});
