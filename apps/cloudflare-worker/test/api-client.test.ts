import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import { ApiError, DraftApprovalClient } from "@draft-approval/api.client";
import { LOCAL_AGENT_TOKEN, type ListDraftsQuery } from "@draft-approval/api.routes";

import { useWorker, type TestWorker } from "#test/use-worker.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Hello",
  body: { plainText: "Hello Ada" },
};

const UNKNOWN_DRAFT_ID = "drf_00000000-0000-7000-8000-000000000000";

test("the client creates a Draft and reads it back with its body", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);

  const created = await client.createDraft(DRAFT_DATA);
  const draft = await client.getDraft(created.id);

  expect(created).toMatchObject({
    reviewStatus: "UNSUBMITTED",
    latestRevision: { revisionNumber: 1, to: ["ada@example.com"], subject: "Hello" },
    sending: { status: "NOT_SENT" },
  });
  expect(created.latestRevision).not.toHaveProperty("body");
  expect(draft).toStrictEqual({
    ...created,
    latestRevision: { ...created.latestRevision, body: { plainText: "Hello Ada" } },
  });
});

test("the client revises a Draft and reads any of its Revisions", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const created = await client.createDraft(DRAFT_DATA);

  const revised = await client.reviseDraft(created.id, {
    ...DRAFT_DATA,
    subject: "Hello again",
    baseRevisionId: created.latestRevision.id,
  });
  const base = await client.getRevision(created.id, created.latestRevision.id);

  expect(revised).toMatchObject({
    id: created.id,
    reviewStatus: "UNSUBMITTED",
    latestRevision: { revisionNumber: 2, subject: "Hello again", reviewStatus: "UNSUBMITTED" },
  });
  expect(revised.latestRevision).not.toHaveProperty("body");
  expect(base).toStrictEqual({
    ...created.latestRevision,
    reviewStatus: "SUPERSEDED",
    body: { plainText: "Hello Ada" },
  });
});

test("a revise on a superseded base throws an ApiError with REVISION_SUPERSEDED", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const created = await client.createDraft(DRAFT_DATA);
  const revise = { ...DRAFT_DATA, baseRevisionId: created.latestRevision.id };
  await client.reviseDraft(created.id, revise);

  const error = await catchApiError(client.reviseDraft(created.id, revise));

  expect(error).toMatchObject({ status: 409, code: "REVISION_SUPERSEDED", extras: {} });
});

test("the client submits a Revision, and a repeated Submission throws an ApiError with REVISION_ALREADY_SUBMITTED", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const created = await client.createDraft(DRAFT_DATA);

  const submitted = await client.submitRevision(created.id, created.latestRevision.id);
  const error = await catchApiError(client.submitRevision(created.id, created.latestRevision.id));

  expect(submitted).toMatchObject({
    id: created.id,
    reviewStatus: "PENDING",
    latestRevision: { id: created.latestRevision.id, reviewStatus: "PENDING" },
  });
  expect(submitted.latestRevision).not.toHaveProperty("body");
  expect(error).toMatchObject({ status: 409, code: "REVISION_ALREADY_SUBMITTED", extras: {} });
});

test("submitting a Rejected Revision throws an ApiError with REVISION_ALREADY_DECIDED and the existing verdict", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const created = await client.createDraft(DRAFT_DATA);
  await client.submitRevision(created.id, created.latestRevision.id);
  const env = await worker.getEnv();
  // Verdicts do not exist yet: the Rejection is written directly.
  await env.DB.prepare(
    "UPDATE revisions SET review_status = 'REJECTED', decided_at = ?1 WHERE id = ?2",
  )
    .bind(Temporal.Now.instant().epochMilliseconds, created.latestRevision.id)
    .run();

  const error = await catchApiError(client.submitRevision(created.id, created.latestRevision.id));

  expect(error).toMatchObject({
    status: 409,
    code: "REVISION_ALREADY_DECIDED",
    extras: { existingVerdict: "REJECTED" },
  });
});

test("getting another Draft's Revision throws an ApiError with REVISION_NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const created = await client.createDraft(DRAFT_DATA);
  const other = await client.createDraft(DRAFT_DATA);

  const error = await catchApiError(client.getRevision(created.id, other.latestRevision.id));

  expect(error).toMatchObject({ status: 404, code: "REVISION_NOT_FOUND" });
});

test("the client lists Drafts with repeated filters and pages through them with the cursor", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const unsubmitted = await client.createDraft(DRAFT_DATA);
  const pendingIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const created = await client.createDraft(DRAFT_DATA);
    await client.submitRevision(created.id, created.latestRevision.id);
    pendingIds.push(created.id);
  }

  const query: ListDraftsQuery = { reviewStatus: ["PENDING", "UNSUBMITTED"], order: "asc" };
  const firstPage = await client.listDrafts({ ...query, limit: 3 });
  const secondPage = await client.listDrafts({ ...query, limit: 3, cursor: firstPage.nextCursor });
  const pendingPage = await client.listDrafts({ reviewStatus: ["PENDING"] });

  expect([...firstPage.items, ...secondPage.items].map((item) => item.id)).toStrictEqual([
    unsubmitted.id,
    ...pendingIds,
  ]);
  expect(firstPage.items[0]).toStrictEqual(unsubmitted);
  expect(secondPage).not.toHaveProperty("nextCursor");
  expect(pendingPage.items.map((item) => item.id)).toStrictEqual(pendingIds.toReversed());
});

test("listing with a cursor of other filters throws an ApiError with INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  await client.createDraft(DRAFT_DATA);
  await client.createDraft(DRAFT_DATA);
  const firstPage = await client.listDrafts({ limit: 1 });

  const error = await catchApiError(
    client.listDrafts({ sendingStatus: ["NOT_SENT"], cursor: firstPage.nextCursor }),
  );

  expect(error).toMatchObject({
    status: 400,
    code: "INVALID_REQUEST",
    extras: { issues: [{ path: ["cursor"] }] },
  });
});

test("the client sends the latest read bookmark it received on every request", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const exchanges: { sentBookmark: string | null; receivedBookmark: string | null }[] = [];
  const client = new DraftApprovalClient({
    baseUrl: "http://localhost",
    token: LOCAL_AGENT_TOKEN,
    fetch: async (request) => {
      const response = await fetchThroughWorker(worker, request);
      exchanges.push({
        sentBookmark: request.headers.get("X-Read-Bookmark"),
        receivedBookmark: response.headers.get("X-Read-Bookmark"),
      });
      return response;
    },
  });

  const created = await client.createDraft(DRAFT_DATA);
  await client.getDraft(created.id);
  await client.getDraft(created.id);

  expect(exchanges).toHaveLength(3);
  const [create, firstGet, secondGet] = exchanges;
  expect(create?.sentBookmark).toBeNull();
  expect(create?.receivedBookmark).toMatch(/^\S+$/);
  expect(firstGet?.sentBookmark).toBe(create?.receivedBookmark);
  expect(secondGet?.sentBookmark).toBe(firstGet?.receivedBookmark);
});

test("the client keeps the read bookmark of an error response too", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const sentBookmarks: (string | null)[] = [];
  let lastReceivedBookmark: string | null = null;
  const client = new DraftApprovalClient({
    baseUrl: "http://localhost",
    token: LOCAL_AGENT_TOKEN,
    fetch: async (request) => {
      sentBookmarks.push(request.headers.get("X-Read-Bookmark"));
      const response = await fetchThroughWorker(worker, request);
      lastReceivedBookmark = response.headers.get("X-Read-Bookmark");
      return response;
    },
  });

  await expect(client.getDraft(UNKNOWN_DRAFT_ID)).rejects.toBeInstanceOf(ApiError);
  const bookmarkOfNotFound = lastReceivedBookmark;
  await expect(client.getDraft(UNKNOWN_DRAFT_ID)).rejects.toBeInstanceOf(ApiError);

  expect(bookmarkOfNotFound).toMatch(/^\S+$/);
  expect(sentBookmarks).toStrictEqual([null, bookmarkOfNotFound]);
});

test("an error response throws an ApiError with status, code, message and request id", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);

  const error = await catchApiError(client.getDraft(UNKNOWN_DRAFT_ID));

  expect(error).toMatchObject({
    status: 404,
    code: "DRAFT_NOT_FOUND",
    message: "No Draft has this id.",
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    extras: {},
  });
});

test("an INVALID_REQUEST error carries its issues as extras", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);

  const error = await catchApiError(client.createDraft({ ...DRAFT_DATA, subject: "" }));

  expect(error).toMatchObject({
    status: 400,
    code: "INVALID_REQUEST",
    extras: { issues: [{ path: ["subject"], message: expect.any(String) }] },
  });
});

test("a refused token never appears in the ApiError", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const token = "agent_secret-token-that-is-not-configured";
  const client = createClient(worker, token);

  const error = await catchApiError(client.getDraft(UNKNOWN_DRAFT_ID));

  expect(error).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  expect(String(error)).not.toContain(token);
  expect(JSON.stringify(error)).not.toContain(token);
  expect(error.stack).not.toContain(token);
});

test("a request over 128 KB throws an ApiError with PAYLOAD_TOO_LARGE", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);

  const error = await catchApiError(
    client.createDraft({ ...DRAFT_DATA, body: { plainText: "x".repeat(129 * 1024) } }),
  );

  expect(error).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
});

function createClient(worker: TestWorker, token: string): DraftApprovalClient {
  return new DraftApprovalClient({
    baseUrl: "http://localhost",
    token,
    fetch: (request) => fetchThroughWorker(worker, request),
  });
}

/**
 * Sends the client's request to the test Worker. The test runtime speaks Miniflare's fetch types,
 * the client the Workers runtime's, so the request and the response are copied across.
 */
async function fetchThroughWorker(worker: TestWorker, request: Request): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await worker.fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body: hasBody ? await request.text() : null,
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: [...response.headers],
  });
}

/** Awaits a client call that must fail with an {@link ApiError} and returns that error. */
async function catchApiError(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("The call succeeded, but it was expected to fail with an ApiError.");
}
