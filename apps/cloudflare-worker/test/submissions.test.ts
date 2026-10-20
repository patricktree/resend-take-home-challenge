import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import {
  draftSummarySchema,
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  type DraftSummaryResponse,
} from "@draft-approval/api.routes";

import { useWorker, type TestWorker } from "#test/use-worker.ts";

const AGENT_HEADERS = {
  Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada,\n\nthe report is attached.\n" },
};

const REVISED_DRAFT_DATA = {
  to: ["ada@example.com", "grace@example.com"],
  subject: "Quarterly report, revised",
  body: { plainText: "Hello Ada and Grace,\n\nthe revised report is attached.\n" },
};

const UNKNOWN_DRAFT_ID = "drf_00000000-0000-7000-8000-000000000000";
const UNKNOWN_REVISION_ID = "rev_00000000-0000-7000-8000-000000000000";

test("submitting the latest Revision answers with 200 and a Pending Draft summary", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const before = Temporal.Now.instant().epochMilliseconds;
  const response = await submitRevision(worker, created.id, created.latestRevision.id);
  const after = Temporal.Now.instant().epochMilliseconds;

  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const submitted = draftSummarySchema.parse(body);
  expect(body).toStrictEqual({
    ...created,
    lastActionAt: expect.any(String),
    reviewStatus: "PENDING",
    latestRevision: {
      ...created.latestRevision,
      reviewStatus: "PENDING",
      submittedAt: submitted.lastActionAt,
    },
  });
  const submittedAt = Temporal.Instant.from(submitted.lastActionAt).epochMilliseconds;
  expect(submittedAt).toBeGreaterThanOrEqual(before);
  expect(submittedAt).toBeLessThanOrEqual(after);
});

test("after a Submission, getting the Draft answers with the Pending Revision and its body", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const submitted = await expectSubmitted(worker, created.id, created.latestRevision.id);

  const response = await worker.fetch(`/api/v1/drafts/${created.id}`, { headers: AGENT_HEADERS });

  expect(await response.json()).toStrictEqual({
    ...submitted,
    latestRevision: { ...submitted.latestRevision, body: DRAFT_DATA.body },
  });
});

test("the Reviewer token can submit a Revision too", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const response = await worker.fetch(
    `/api/v1/drafts/${created.id}/revisions/${created.latestRevision.id}/submission`,
    { method: "POST", headers: { Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` } },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ reviewStatus: "PENDING" });
});

test("submitting a Pending Revision again answers with 409 REVISION_ALREADY_SUBMITTED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  await expectSubmitted(worker, created.id, created.latestRevision.id);
  const rowsBefore = await readRows(worker);

  const response = await submitRevision(worker, created.id, created.latestRevision.id);

  expect(response.status).toBe(409);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "REVISION_ALREADY_SUBMITTED",
      message: expect.any(String),
      requestId: response.headers.get("X-Request-Id"),
    },
  });
  expect(await readRows(worker)).toStrictEqual(rowsBefore);
});

test("submitting a Rejected Revision answers with 409 REVISION_ALREADY_DECIDED with existingVerdict REJECTED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  await expectSubmitted(worker, created.id, created.latestRevision.id);
  await expectRejected(worker, created.id, created.latestRevision.id);
  const rowsBefore = await readRows(worker);

  const response = await submitRevision(worker, created.id, created.latestRevision.id);

  expect(response.status).toBe(409);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "REVISION_ALREADY_DECIDED",
      message: expect.any(String),
      requestId: response.headers.get("X-Request-Id"),
      existingVerdict: "REJECTED",
    },
  });
  expect(await readRows(worker)).toStrictEqual(rowsBefore);
});

test.for([
  { name: "an Unsubmitted", isSubmittedBeforeRevise: false, isRejectedBeforeRevise: false },
  { name: "a Pending", isSubmittedBeforeRevise: true, isRejectedBeforeRevise: false },
  // REVISION_SUPERSEDED takes precedence over REVISION_ALREADY_DECIDED.
  { name: "a Rejected", isSubmittedBeforeRevise: true, isRejectedBeforeRevise: true },
])(
  "submitting $name Revision that is no longer the latest answers with 409 REVISION_SUPERSEDED and changes nothing",
  async ({ isSubmittedBeforeRevise, isRejectedBeforeRevise }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    if (isSubmittedBeforeRevise) {
      await expectSubmitted(worker, created.id, created.latestRevision.id);
    }
    if (isRejectedBeforeRevise) {
      await expectRejected(worker, created.id, created.latestRevision.id);
    }
    await expectRevised(worker, created.id, created.latestRevision.id);
    const rowsBefore = await readRows(worker);

    const response = await submitRevision(worker, created.id, created.latestRevision.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "REVISION_SUPERSEDED",
        message: expect.any(String),
        requestId: response.headers.get("X-Request-Id"),
      },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test.for([
  // DRAFT_APPROVED takes precedence over REVISION_ALREADY_DECIDED.
  { name: "its approved Revision", isApprovedRevisionSubmitted: true },
  // DRAFT_APPROVED takes precedence over REVISION_SUPERSEDED.
  { name: "a Superseded Revision", isApprovedRevisionSubmitted: false },
])(
  "submitting $name of an approved Draft answers with 409 DRAFT_APPROVED and changes nothing",
  async ({ isApprovedRevisionSubmitted }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const revised = await expectRevised(worker, created.id, created.latestRevision.id);
    await expectSubmitted(worker, created.id, revised.latestRevision.id);
    await expectApproved(worker, created.id, revised.latestRevision.id);
    const rowsBefore = await readRows(worker);

    const response = await submitRevision(
      worker,
      created.id,
      isApprovedRevisionSubmitted ? revised.latestRevision.id : created.latestRevision.id,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "DRAFT_APPROVED",
        message: expect.any(String),
        requestId: response.headers.get("X-Request-Id"),
      },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test.for([
  { name: "an unknown Revision", isOtherDraftsRevision: false },
  { name: "another Draft's Revision", isOtherDraftsRevision: true },
])(
  "submitting $name answers with 404 REVISION_NOT_FOUND and changes nothing",
  async ({ isOtherDraftsRevision }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const other = await createDraft(worker);
    const rowsBefore = await readRows(worker);

    const response = await submitRevision(
      worker,
      created.id,
      isOtherDraftsRevision ? other.latestRevision.id : UNKNOWN_REVISION_ID,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "REVISION_NOT_FOUND",
        message: "The Draft has no Revision with this id.",
        requestId: response.headers.get("X-Request-Id"),
      },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test("submitting another Draft's Revision through an approved Draft answers with 404 REVISION_NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const other = await createDraft(worker);
  await expectSubmitted(worker, created.id, created.latestRevision.id);
  await expectApproved(worker, created.id, created.latestRevision.id);
  const rowsBefore = await readRows(worker);

  // REVISION_NOT_FOUND takes precedence over DRAFT_APPROVED.
  const response = await submitRevision(worker, created.id, other.latestRevision.id);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "REVISION_NOT_FOUND" } });
  expect(await readRows(worker)).toStrictEqual(rowsBefore);
});

test("submitting a Revision of an unknown Draft answers with 404 DRAFT_NOT_FOUND and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const rowsBefore = await readRows(worker);

  const response = await submitRevision(worker, UNKNOWN_DRAFT_ID, created.latestRevision.id);

  expect(response.status).toBe(404);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "DRAFT_NOT_FOUND",
      message: "No Draft has this id.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
  expect(await readRows(worker)).toStrictEqual(rowsBefore);
});

test("submitting by a Draft id as Revision id answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const response = await submitRevision(worker, created.id, created.id);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "INVALID_REQUEST", issues: [{ path: ["revisionId"] }] },
  });
});

test("revising a Pending Draft supersedes the Pending Revision and withdraws its Submission", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const submitted = await expectSubmitted(worker, created.id, created.latestRevision.id);

  const revised = await expectRevised(worker, created.id, created.latestRevision.id);
  const base = await getRevision(worker, created.id, created.latestRevision.id);
  const draft = await worker.fetch(`/api/v1/drafts/${created.id}`, { headers: AGENT_HEADERS });

  expect(revised).toMatchObject({
    reviewStatus: "UNSUBMITTED",
    latestRevision: { revisionNumber: 2, reviewStatus: "UNSUBMITTED" },
  });
  expect(revised.latestRevision).not.toHaveProperty("submittedAt");
  expect(await base.json()).toStrictEqual({
    ...submitted.latestRevision,
    reviewStatus: "SUPERSEDED",
    body: DRAFT_DATA.body,
  });
  expect(await draft.json()).toMatchObject({
    reviewStatus: "UNSUBMITTED",
    latestRevision: { id: revised.latestRevision.id, reviewStatus: "UNSUBMITTED" },
  });
});

test("after a Rejection, the revised Revision can be submitted and the Rejected one stays Rejected", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  await expectSubmitted(worker, created.id, created.latestRevision.id);
  await expectRejected(worker, created.id, created.latestRevision.id);
  const revised = await expectRevised(worker, created.id, created.latestRevision.id);

  const response = await submitRevision(worker, created.id, revised.latestRevision.id);
  const base = await getRevision(worker, created.id, created.latestRevision.id);

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    reviewStatus: "PENDING",
    latestRevision: { id: revised.latestRevision.id, revisionNumber: 2, reviewStatus: "PENDING" },
  });
  expect(await base.json()).toMatchObject({
    reviewStatus: "REJECTED",
    rejectionReason: "Wrong recipient",
  });
});

test("10 concurrent Submissions of the same Revision: one 200, nine 409 REVISION_ALREADY_SUBMITTED and exactly one Submission", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => submitRevision(worker, created.id, created.latestRevision.id)),
  );

  const statuses = responses.map((response) => response.status);
  expect(statuses.filter((status) => status === 200)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409)).toHaveLength(9);
  const losers = responses.filter((response) => response.status === 409);
  const loserBodies: unknown[] = await Promise.all(losers.map((response) => response.json()));
  expect(loserBodies).toStrictEqual(
    Array.from({ length: 9 }, () => ({
      error: expect.objectContaining({ code: "REVISION_ALREADY_SUBMITTED" }),
    })),
  );
  // The losers changed nothing: the rows hold exactly the winner's Submission.
  const winner = responses.find((response) => response.status === 200);
  const submitted = draftSummarySchema.parse(await winner?.json());
  const { drafts, revisions } = await readRows(worker);
  expect(drafts).toMatchObject([
    {
      id: created.id,
      latest_revision_id: created.latestRevision.id,
      last_action_at: Temporal.Instant.from(submitted.lastActionAt).epochMilliseconds,
    },
  ]);
  expect(revisions).toMatchObject([
    {
      id: created.latestRevision.id,
      review_status: "PENDING",
      submitted_at: Temporal.Instant.from(submitted.lastActionAt).epochMilliseconds,
    },
  ]);
});

test("a concurrent Submission and revise end in one of the two outcomes of their commit order", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const [submitResponse, reviseResponse] = await Promise.all([
    submitRevision(worker, created.id, created.latestRevision.id),
    reviseDraft(worker, created.id, created.latestRevision.id),
  ]);

  expect(reviseResponse.status).toBe(201);
  const revised = draftSummarySchema.parse(await reviseResponse.json());
  const submitBody: unknown = await submitResponse.json();
  const { drafts, revisions } = await readRows(worker);
  const observed = {
    submit: { status: submitResponse.status, body: submitBody },
    drafts,
    revisions,
  };
  // Revise first: the Submission loses and changes nothing, so the base was never submitted.
  // Submit first: the revise supersedes the now-Pending base, which keeps its `submitted_at`.
  const isReviseFirst = submitResponse.status === 409;
  expect(observed).toStrictEqual({
    submit: isReviseFirst
      ? { status: 409, body: { error: expect.objectContaining({ code: "REVISION_SUPERSEDED" }) } }
      : { status: 200, body: expect.objectContaining({ reviewStatus: "PENDING" }) },
    drafts: [
      expect.objectContaining({
        latest_revision_id: revised.latestRevision.id,
        last_action_at: Temporal.Instant.from(revised.lastActionAt).epochMilliseconds,
      }),
    ],
    revisions: [
      expect.objectContaining({
        id: created.latestRevision.id,
        review_status: "SUPERSEDED",
        submitted_at: isReviseFirst ? null : expect.any(Number),
      }),
      expect.objectContaining({
        id: revised.latestRevision.id,
        review_status: "UNSUBMITTED",
        submitted_at: null,
      }),
    ],
  });
});

async function createDraft(worker: TestWorker): Promise<DraftSummaryResponse> {
  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify(DRAFT_DATA),
  });
  return draftSummarySchema.parse(await response.json());
}

async function submitRevision(worker: TestWorker, draftId: string, revisionId: string) {
  return worker.fetch(`/api/v1/drafts/${draftId}/revisions/${revisionId}/submission`, {
    method: "POST",
    headers: { Authorization: AGENT_HEADERS.Authorization },
  });
}

/** Submits the Revision and fails the test unless the Submission succeeds. */
async function expectSubmitted(
  worker: TestWorker,
  draftId: string,
  revisionId: string,
): Promise<DraftSummaryResponse> {
  const response = await submitRevision(worker, draftId, revisionId);
  if (response.status !== 200) {
    throw new Error(`The Submission answered with ${response.status}: ${await response.text()}`);
  }
  return draftSummarySchema.parse(await response.json());
}

async function reviseDraft(worker: TestWorker, draftId: string, baseRevisionId: string) {
  return worker.fetch(`/api/v1/drafts/${draftId}/revisions`, {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify({ ...REVISED_DRAFT_DATA, baseRevisionId }),
  });
}

/** Revises the Draft and fails the test unless the revise succeeds. */
async function expectRevised(
  worker: TestWorker,
  draftId: string,
  baseRevisionId: string,
): Promise<DraftSummaryResponse> {
  const response = await reviseDraft(worker, draftId, baseRevisionId);
  if (response.status !== 201) {
    throw new Error(`The revise answered with ${response.status}: ${await response.text()}`);
  }
  return draftSummarySchema.parse(await response.json());
}

async function getRevision(worker: TestWorker, draftId: string, revisionId: string) {
  return worker.fetch(`/api/v1/drafts/${draftId}/revisions/${revisionId}`, {
    headers: AGENT_HEADERS,
  });
}

async function readRows(worker: TestWorker) {
  const env = await worker.getEnv();
  const [drafts, revisions] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM drafts ORDER BY id"),
    env.DB.prepare("SELECT * FROM revisions ORDER BY draft_id, revision_number"),
  ]);
  return { drafts: drafts?.results, revisions: revisions?.results };
}

/** Rejects the Pending latest Revision with the reason "Wrong recipient"; fails the test otherwise. */
async function expectRejected(worker: TestWorker, draftId: string, revisionId: string) {
  const response = await worker.fetch(
    `/api/v1/drafts/${draftId}/revisions/${revisionId}/rejection`,
    {
      method: "POST",
      headers: { ...AGENT_HEADERS, Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` },
      body: JSON.stringify({ reason: "Wrong recipient" }),
    },
  );
  if (response.status !== 200) {
    throw new Error(`The Rejection answered with ${response.status}: ${await response.text()}`);
  }
}

/** Approves the Pending latest Revision; fails the test otherwise. */
async function expectApproved(worker: TestWorker, draftId: string, revisionId: string) {
  const response = await worker.fetch(
    `/api/v1/drafts/${draftId}/revisions/${revisionId}/approval`,
    { method: "POST", headers: { Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` } },
  );
  if (response.status !== 200) {
    throw new Error(`The Approval answered with ${response.status}: ${await response.text()}`);
  }
}
