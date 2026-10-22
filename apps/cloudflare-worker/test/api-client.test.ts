import { test } from "vitest";

import { ApiError, ApiClient } from "@resend-challenge/api.client";
import {
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  type ListDraftsQuery,
} from "@resend-challenge/api.routes";

import { reviewUrlOf, useWorker, type TestWorker } from "./use-worker.ts";

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

  const created = await client.drafts.create(DRAFT_DATA);
  const draft = await client.drafts.get(created.id);

  expect(created).toMatchObject({
    reviewStatus: "UNSUBMITTED",
    latestRevision: { revisionNumber: 1, to: ["ada@example.com"], subject: "Hello" },
    sending: { status: "NOT_SENT" },
  });
  expect(created.latestRevision).not.toHaveProperty("body");
  expect(created).not.toHaveProperty("reviewUrl");
  expect(draft).toStrictEqual({
    ...created,
    reviewUrl: reviewUrlOf(created.id),
    latestRevision: { ...created.latestRevision, body: { plainText: "Hello Ada" } },
  });
});

test("the client revises a Draft and reads any of its Revisions", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const created = await client.drafts.create(DRAFT_DATA);

  const revised = await client.drafts.revise(created.id, {
    ...DRAFT_DATA,
    subject: "Hello again",
    baseRevisionId: created.latestRevision.id,
  });
  const base = await client.revisions.get(created.id, created.latestRevision.id);

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

test("the client submits a Revision, and a repeated Submission throws an ApiError with REVISION_ALREADY_SUBMITTED", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const created = await client.drafts.create(DRAFT_DATA);

  const submitted = await client.revisions.submit(created.id, created.latestRevision.id);
  const error = await catchApiError(client.revisions.submit(created.id, created.latestRevision.id));

  expect(submitted).toMatchObject({
    id: created.id,
    reviewStatus: "PENDING",
    latestRevision: { id: created.latestRevision.id, reviewStatus: "PENDING" },
  });
  expect(submitted.latestRevision).not.toHaveProperty("body");
  expect(error).toMatchObject({ code: "REVISION_ALREADY_SUBMITTED", extras: {} });
});

test("the Reviewer's client approves a Revision, and a repeated Approval throws an ApiError with REVISION_ALREADY_DECIDED", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const agentClient = createClient(worker, LOCAL_AGENT_TOKEN);
  const reviewerClient = createClient(worker, LOCAL_REVIEWER_TOKEN);
  const created = await agentClient.drafts.create(DRAFT_DATA);
  await agentClient.revisions.submit(created.id, created.latestRevision.id);

  const approved = await reviewerClient.revisions.approve(created.id, created.latestRevision.id);
  const error = await catchApiError(
    reviewerClient.revisions.approve(created.id, created.latestRevision.id),
  );

  expect(approved).toMatchObject({
    reviewStatus: "APPROVED",
    lastVerdict: { revisionId: created.latestRevision.id, verdict: "APPROVED" },
    sending: { status: "QUEUED" },
  });
  expect(error).toMatchObject({
    code: "REVISION_ALREADY_DECIDED",
    extras: { existingVerdict: "APPROVED" },
  });
});

test("the Reviewer's client rejects a Revision with and without a reason", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const agentClient = createClient(worker, LOCAL_AGENT_TOKEN);
  const reviewerClient = createClient(worker, LOCAL_REVIEWER_TOKEN);
  const first = await agentClient.drafts.create(DRAFT_DATA);
  const second = await agentClient.drafts.create(DRAFT_DATA);
  await agentClient.revisions.submit(first.id, first.latestRevision.id);
  await agentClient.revisions.submit(second.id, second.latestRevision.id);

  const withReason = await reviewerClient.revisions.reject(first.id, first.latestRevision.id, {
    reason: "Wrong recipient",
  });
  const withoutReason = await reviewerClient.revisions.reject(second.id, second.latestRevision.id);

  expect(withReason).toMatchObject({
    reviewStatus: "REJECTED",
    lastVerdict: { verdict: "REJECTED", reason: "Wrong recipient" },
    sending: { status: "NOT_SENT" },
  });
  expect(withoutReason).toMatchObject({ lastVerdict: { verdict: "REJECTED" } });
  expect(withoutReason.lastVerdict).not.toHaveProperty("reason");
});

test.for([
  { name: "approve", isApproval: true },
  { name: "reject", isApproval: false },
])(
  "an Agent's client that tries to $name throws an ApiError with REVIEWER_ONLY",
  async ({ isApproval }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const client = createClient(worker, LOCAL_AGENT_TOKEN);
    const created = await client.drafts.create(DRAFT_DATA);
    await client.revisions.submit(created.id, created.latestRevision.id);

    const error = await catchApiError(
      isApproval
        ? client.revisions.approve(created.id, created.latestRevision.id)
        : client.revisions.reject(created.id, created.latestRevision.id),
    );

    expect(error).toMatchObject({ code: "REVIEWER_ONLY", extras: {} });
  },
);

test("the client lists Drafts with repeated filters and pages through them with the cursor", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);
  const unsubmitted = await client.drafts.create(DRAFT_DATA);
  const pendingIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const created = await client.drafts.create(DRAFT_DATA);
    await client.revisions.submit(created.id, created.latestRevision.id);
    pendingIds.push(created.id);
  }

  const query: ListDraftsQuery = { reviewStatus: ["PENDING", "UNSUBMITTED"], order: "asc" };
  const firstPage = await client.drafts.list({ ...query, limit: 3 });
  const secondPage = await client.drafts.list({ ...query, limit: 3, cursor: firstPage.nextCursor });
  const pendingPage = await client.drafts.list({ reviewStatus: ["PENDING"] });

  expect([...firstPage.items, ...secondPage.items].map((item) => item.id)).toStrictEqual([
    unsubmitted.id,
    ...pendingIds,
  ]);
  expect(firstPage.items[0]).toStrictEqual({
    ...unsubmitted,
    reviewUrl: reviewUrlOf(unsubmitted.id),
  });
  expect(secondPage).not.toHaveProperty("nextCursor");
  expect(pendingPage.items.map((item) => item.id)).toStrictEqual(pendingIds.toReversed());
});

test("the client sends the latest read bookmark it received on every request", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const exchanges: { sentBookmark: string | null; receivedBookmark: string | null }[] = [];
  const client = new ApiClient({
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

  const created = await client.drafts.create(DRAFT_DATA);
  await client.drafts.get(created.id);
  await client.drafts.get(created.id);

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
  const client = new ApiClient({
    baseUrl: "http://localhost",
    token: LOCAL_AGENT_TOKEN,
    fetch: async (request) => {
      sentBookmarks.push(request.headers.get("X-Read-Bookmark"));
      const response = await fetchThroughWorker(worker, request);
      lastReceivedBookmark = response.headers.get("X-Read-Bookmark");
      return response;
    },
  });

  await expect(client.drafts.get(UNKNOWN_DRAFT_ID)).rejects.toBeInstanceOf(ApiError);
  const bookmarkOfNotFound = lastReceivedBookmark;
  await expect(client.drafts.get(UNKNOWN_DRAFT_ID)).rejects.toBeInstanceOf(ApiError);

  expect(bookmarkOfNotFound).toMatch(/^\S+$/);
  expect(sentBookmarks).toStrictEqual([null, bookmarkOfNotFound]);
});

test("an error response throws an ApiError with code, message and request id, and no HTTP status", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);

  const error = await catchApiError(client.drafts.get(UNKNOWN_DRAFT_ID));

  expect(error).toMatchObject({
    code: "DRAFT_NOT_FOUND",
    message: "No Draft has this id.",
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    extras: {},
  });
  expect(error).not.toHaveProperty("status");
});

test("an INVALID_REQUEST error carries its issues as extras", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const client = createClient(worker, LOCAL_AGENT_TOKEN);

  const error = await catchApiError(client.drafts.create({ ...DRAFT_DATA, subject: "" }));

  expect(error).toMatchObject({
    code: "INVALID_REQUEST",
    extras: { issues: [{ path: ["subject"], message: expect.any(String) }] },
  });
});

test("a refused token never appears in the ApiError", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const token = "agent_secret-token-that-is-not-configured";
  const client = createClient(worker, token);

  const error = await catchApiError(client.drafts.get(UNKNOWN_DRAFT_ID));

  expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
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
    client.drafts.create({ ...DRAFT_DATA, body: { plainText: "x".repeat(129 * 1024) } }),
  );

  expect(error).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
});

test.for([
  { name: "an unknown code", code: "SOMETHING_NEW" },
  { name: "a code that is not a string", code: 409 },
])(
  "an error envelope with $name throws a plain error naming the status, never an ApiError",
  async ({ code }, { expect }) => {
    const client = new ApiClient({
      baseUrl: "http://localhost",
      token: LOCAL_AGENT_TOKEN,
      fetch: async () =>
        Response.json(
          { error: { code, message: "Something new.", requestId: "request-id" } },
          { status: 409 },
        ),
    });

    const failure = client.drafts.get(UNKNOWN_DRAFT_ID);

    await expect(failure).rejects.toThrow(
      "The API answered with status 409 and no error envelope.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ApiError);
  },
);

function createClient(worker: TestWorker, token: string): ApiClient {
  return new ApiClient({
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
