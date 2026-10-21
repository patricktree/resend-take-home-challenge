import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import {
  draftSummarySchema,
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
} from "@resend-challenge/api.routes";

import { useWorker, type TestWorker } from "./use-worker.ts";

const AGENT_HEADERS = {
  Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

const DRAFT_DATA = {
  to: ["ada@example.com", "grace@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada and Grace,\n\nthe report is attached.\n" },
};

const DRAFT_ID_PATTERN =
  /^drf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION_ID_PATTERN =
  /^rev_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNKNOWN_DRAFT_ID = "drf_00000000-0000-7000-8000-000000000000";

test("creating a Draft answers with 201 and a Draft summary of Revision 1", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const before = Temporal.Now.instant().epochMilliseconds;
  const response = await createDraft(worker, DRAFT_DATA);
  const after = Temporal.Now.instant().epochMilliseconds;

  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  const draft = draftSummarySchema.parse(body);
  expect(body).toStrictEqual({
    id: expect.stringMatching(DRAFT_ID_PATTERN),
    createdAt: expect.stringMatching(ISO_TIMESTAMP_PATTERN),
    lastActionAt: draft.createdAt,
    reviewStatus: "UNSUBMITTED",
    latestRevision: {
      id: expect.stringMatching(REVISION_ID_PATTERN),
      revisionNumber: 1,
      createdAt: draft.createdAt,
      to: ["ada@example.com", "grace@example.com"],
      subject: "Quarterly report",
      reviewStatus: "UNSUBMITTED",
    },
    sending: { status: "NOT_SENT" },
    reviewUrl: `https://resend-challenge.patricktree.me/app/drafts/${draft.id}`,
  });
  expect(Temporal.Instant.from(draft.createdAt).epochMilliseconds).toBeGreaterThanOrEqual(before);
  expect(Temporal.Instant.from(draft.createdAt).epochMilliseconds).toBeLessThanOrEqual(after);
});

test("getting a created Draft answers with the full Draft including the body", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = draftSummarySchema.parse(await (await createDraft(worker, DRAFT_DATA)).json());

  const response = await worker.fetch(`/api/v1/drafts/${created.id}`, { headers: AGENT_HEADERS });

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    ...created,
    latestRevision: {
      ...created.latestRevision,
      body: { plainText: "Hello Ada and Grace,\n\nthe report is attached.\n" },
    },
  });
});

test("the Revision body is stored in R2 as JSON under the Revision's id", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const created = draftSummarySchema.parse(await (await createDraft(worker, DRAFT_DATA)).json());

  const env = await worker.getEnv();
  const object = await env.REVISION_BODIES.get(`revisions/${created.latestRevision.id}/body`);
  expect(await object?.json()).toStrictEqual({
    plainText: "Hello Ada and Grace,\n\nthe report is attached.\n",
  });
});

test("the Reviewer token can create and get a Draft too", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const headers = { ...AGENT_HEADERS, Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` };

  const createResponse = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers,
    body: JSON.stringify(DRAFT_DATA),
  });
  const created = draftSummarySchema.parse(await createResponse.json());
  const getResponse = await worker.fetch(`/api/v1/drafts/${created.id}`, { headers });

  expect(createResponse.status).toBe(201);
  expect(getResponse.status).toBe(200);
});

test("every create makes a new Draft, even with the same Draft data", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const first = draftSummarySchema.parse(await (await createDraft(worker, DRAFT_DATA)).json());
  const second = draftSummarySchema.parse(await (await createDraft(worker, DRAFT_DATA)).json());

  expect(second.id).not.toBe(first.id);
  expect(second.latestRevision.id).not.toBe(first.latestRevision.id);
  expect(second.latestRevision.revisionNumber).toBe(1);
});

test("getting an unknown Draft answers with 404 DRAFT_NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(`/api/v1/drafts/${UNKNOWN_DRAFT_ID}`, {
    headers: AGENT_HEADERS,
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "DRAFT_NOT_FOUND",
      message: "No Draft has this id.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
});

test.for([
  { name: "a Revision id", draftId: "rev_00000000-0000-7000-8000-000000000000" },
  { name: "an id without prefix", draftId: "00000000-0000-7000-8000-000000000000" },
  { name: "an arbitrary string", draftId: "draft-1" },
])(
  "getting a Draft by $name answers with 400 INVALID_REQUEST",
  async ({ draftId }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(`/api/v1/drafts/${draftId}`, { headers: AGENT_HEADERS });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", issues: [{ path: ["draftId"] }] },
    });
  },
);

async function createDraft(worker: TestWorker, draftData: unknown) {
  return worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify(draftData),
  });
}
