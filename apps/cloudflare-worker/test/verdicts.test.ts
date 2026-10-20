import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import {
  draftSummarySchema,
  errorResponseSchema,
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  type DraftSummaryResponse,
} from "@draft-approval/api.routes";

import { readSentSendQueueMessages, useWorker, type TestWorker } from "#test/use-worker.ts";

const AGENT_HEADERS = {
  Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

const REVIEWER_AUTHORIZATION = `Bearer ${LOCAL_REVIEWER_TOKEN}`;

/** `RESEND_FROM` of test/wrangler.test.jsonc. */
const RESEND_FROM = "drafts@resend-challenge.patricktree.me";

const DRAFT_DATA = {
  to: ["ada@example.com", "grace@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada and Grace,\n\nthe report is attached.\n" },
};

const REVISED_DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report, revised",
  body: { plainText: "Hello Ada,\n\nthe revised report is attached.\n" },
};

const UNKNOWN_DRAFT_ID = "drf_00000000-0000-7000-8000-000000000000";
const UNKNOWN_REVISION_ID = "rev_00000000-0000-7000-8000-000000000000";

const DEADLINE_AFTER_APPROVAL_MILLISECONDS = 23 * 60 * 60 * 1000;

test("approving the Pending latest Revision answers with 200 and an approved, QUEUED Draft summary, and hands one Send intent to the Send Queue", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const revisionId = submitted.latestRevision.id;

  const before = Temporal.Now.instant().epochMilliseconds;
  const response = await approve(worker, submitted.id, revisionId);
  const after = Temporal.Now.instant().epochMilliseconds;

  expect(response.status).toBe(200);
  expect(response.headers.get("X-Read-Bookmark")).toEqual(expect.any(String));
  const body: unknown = await response.json();
  const approved = draftSummarySchema.parse(body);
  expect(body).toStrictEqual({
    ...submitted,
    lastActionAt: approved.lastActionAt,
    reviewStatus: "APPROVED",
    latestRevision: {
      ...submitted.latestRevision,
      reviewStatus: "APPROVED",
      decidedAt: approved.lastActionAt,
    },
    lastVerdict: {
      revisionId,
      revisionNumber: 1,
      verdict: "APPROVED",
      decidedAt: approved.lastActionAt,
    },
    sending: { status: "QUEUED" },
  });
  const approvedAt = Temporal.Instant.from(approved.lastActionAt).epochMilliseconds;
  expect(approvedAt).toBeGreaterThanOrEqual(before);
  expect(approvedAt).toBeLessThanOrEqual(after);
  const outgoingEmail = {
    from: RESEND_FROM,
    to: DRAFT_DATA.to,
    subject: DRAFT_DATA.subject,
    bodyKey: `revisions/${revisionId}/body`,
    tags: [{ name: "draft_id", value: submitted.id }],
  };
  expect(await readSentSendQueueMessages(worker)).toStrictEqual([
    {
      draftId: submitted.id,
      idempotencyKey: `draft-send/${submitted.id}`,
      outgoingEmail,
      deadline: approvedAt + DEADLINE_AFTER_APPROVAL_MILLISECONDS,
    },
  ]);
  const { drafts } = await readRows(worker);
  expect(drafts).toStrictEqual([
    expect.objectContaining({
      sending_status: "QUEUED",
      approved_revision_id: revisionId,
      approved_at: approvedAt,
      idempotency_key: `draft-send/${submitted.id}`,
      outgoing_email: JSON.stringify(outgoingEmail),
      deadline: approvedAt + DEADLINE_AFTER_APPROVAL_MILLISECONDS,
      enqueued_at: expect.any(Number),
    }),
  ]);
});

test("after an Approval, getting the Draft answers with the approved Revision, the last verdict and QUEUED", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const approved = await expectVerdict(
    worker,
    "approve",
    submitted.id,
    submitted.latestRevision.id,
  );

  const response = await worker.fetch(`/api/v1/drafts/${submitted.id}`, {
    headers: AGENT_HEADERS,
  });

  expect(await response.json()).toStrictEqual({
    ...approved,
    latestRevision: { ...approved.latestRevision, body: DRAFT_DATA.body },
  });
});

test("rejecting the Pending latest Revision with a reason answers with 200 and a Rejected Draft summary that keeps the trimmed reason", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const revisionId = submitted.latestRevision.id;

  const response = await reject(worker, submitted.id, revisionId, {
    reason: "  Wrong recipient: Grace is on leave.\n",
  });

  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const rejected = draftSummarySchema.parse(body);
  expect(body).toStrictEqual({
    ...submitted,
    lastActionAt: rejected.lastActionAt,
    reviewStatus: "REJECTED",
    latestRevision: {
      ...submitted.latestRevision,
      reviewStatus: "REJECTED",
      decidedAt: rejected.lastActionAt,
      rejectionReason: "Wrong recipient: Grace is on leave.",
    },
    lastVerdict: {
      revisionId,
      revisionNumber: 1,
      verdict: "REJECTED",
      reason: "Wrong recipient: Grace is on leave.",
      decidedAt: rejected.lastActionAt,
    },
    sending: { status: "NOT_SENT" },
  });
  expect(await readSentSendQueueMessages(worker)).toStrictEqual([]);
});

test.for([
  { name: "without a request body", body: undefined },
  { name: "with an empty object", body: {} },
  { name: "with an empty reason", body: { reason: "" } },
  { name: "with a whitespace-only reason", body: { reason: " \n\t " } },
])(
  "rejecting $name records a Rejection without a reason",
  async ({ body }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const submitted = await createSubmittedDraft(worker);

    const response = await reject(worker, submitted.id, submitted.latestRevision.id, body);

    expect(response.status).toBe(200);
    const rejected: unknown = await response.json();
    expect(rejected).toMatchObject({
      reviewStatus: "REJECTED",
      lastVerdict: { verdict: "REJECTED" },
    });
    expect(rejected).not.toHaveProperty("latestRevision.rejectionReason");
    expect(rejected).not.toHaveProperty("lastVerdict.reason");
  },
);

test("a Rejection reason of 2000 characters after trimming is accepted", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  // Counted in characters: each emoji is one character but two UTF-16 code units.
  const reason = "🙂".repeat(2000);

  const response = await reject(worker, submitted.id, submitted.latestRevision.id, {
    reason: `  ${reason}  `,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ lastVerdict: { reason } });
});

test("a Rejection reason of 2001 characters after trimming answers with 400 INVALID_REQUEST and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const rowsBefore = await readRows(worker);

  const response = await reject(worker, submitted.id, submitted.latestRevision.id, {
    reason: "x".repeat(2001),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "INVALID_REQUEST", issues: [{ path: ["reason"] }] },
  });
  expect(await readRows(worker)).toStrictEqual(rowsBefore);
});

test("a Rejection with an unknown field answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);

  const response = await reject(worker, submitted.id, submitted.latestRevision.id, {
    reason: "Wrong recipient",
    verdict: "APPROVED",
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
});

test.for([
  { verdict: "approval", path: "approval" },
  { verdict: "rejection", path: "rejection" },
])(
  "the Agent token on the $verdict route answers with 403 REVIEWER_ONLY and the Draft stays PENDING and NOT_SENT",
  async ({ path }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const submitted = await createSubmittedDraft(worker);
    const rowsBefore = await readRows(worker);

    const response = await worker.fetch(
      `/api/v1/drafts/${submitted.id}/revisions/${submitted.latestRevision.id}/${path}`,
      { method: "POST", headers: AGENT_HEADERS, body: JSON.stringify({}) },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "REVIEWER_ONLY",
        message: "Only the Reviewer token may approve or reject a Revision.",
        requestId: response.headers.get("X-Request-Id"),
      },
    });
    // The guard runs before any database access, so no D1 session hands out a bookmark.
    expect(response.headers.has("X-Read-Bookmark")).toBe(false);
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
    const draft = await worker.fetch(`/api/v1/drafts/${submitted.id}`, { headers: AGENT_HEADERS });
    expect(await draft.json()).toMatchObject({
      reviewStatus: "PENDING",
      sending: { status: "NOT_SENT" },
    });
    expect(await readSentSendQueueMessages(worker)).toStrictEqual([]);
  },
);

test.for([
  { name: "approving", verdict: "approve" },
  { name: "rejecting", verdict: "reject" },
] as const)(
  "$name an Unsubmitted Revision answers with 409 REVISION_NOT_SUBMITTED and changes nothing",
  async ({ verdict }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const rowsBefore = await readRows(worker);

    const response = await renderVerdict(worker, verdict, created.id, created.latestRevision.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "REVISION_NOT_SUBMITTED",
        message: expect.any(String),
        requestId: response.headers.get("X-Request-Id"),
      },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
    expect(await readSentSendQueueMessages(worker)).toStrictEqual([]);
  },
);

test.for([
  { name: "approving an approved", first: "approve", second: "approve", existing: "APPROVED" },
  { name: "rejecting an approved", first: "approve", second: "reject", existing: "APPROVED" },
  { name: "approving a rejected", first: "reject", second: "approve", existing: "REJECTED" },
  { name: "rejecting a rejected", first: "reject", second: "reject", existing: "REJECTED" },
] as const)(
  "$name Revision answers with 409 REVISION_ALREADY_DECIDED with existingVerdict $existing and records nothing",
  async ({ first, second, existing }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const submitted = await createSubmittedDraft(worker);
    const revisionId = submitted.latestRevision.id;
    await expectVerdict(worker, first, submitted.id, revisionId);
    const rowsBefore = await readRows(worker);
    const messagesBefore = await readSentSendQueueMessages(worker);

    const response = await renderVerdict(worker, second, submitted.id, revisionId);

    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "REVISION_ALREADY_DECIDED",
        message: expect.any(String),
        requestId: response.headers.get("X-Request-Id"),
        existingVerdict: existing,
      },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
    expect(await readSentSendQueueMessages(worker)).toStrictEqual(messagesBefore);
  },
);

test.for([
  { name: "approving an Unsubmitted", verdict: "approve", isSubmitted: false, isRejected: false },
  { name: "rejecting a Pending", verdict: "reject", isSubmitted: true, isRejected: false },
  // REVISION_SUPERSEDED takes precedence over REVISION_ALREADY_DECIDED.
  { name: "approving a Rejected", verdict: "approve", isSubmitted: true, isRejected: true },
] as const)(
  "$name Revision that is no longer the latest answers with 409 REVISION_SUPERSEDED and changes nothing",
  async ({ verdict, isSubmitted, isRejected }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const revisionId = created.latestRevision.id;
    if (isSubmitted) {
      await expectSubmitted(worker, created.id, revisionId);
    }
    if (isRejected) {
      await expectVerdict(worker, "reject", created.id, revisionId);
    }
    await expectRevised(worker, created.id, revisionId);
    const rowsBefore = await readRows(worker);

    const response = await renderVerdict(worker, verdict, created.id, revisionId);

    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "REVISION_SUPERSEDED",
        message: expect.any(String),
        requestId: response.headers.get("X-Request-Id"),
      },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
    expect(await readSentSendQueueMessages(worker)).toStrictEqual([]);
  },
);

test.for([
  { name: "an unknown Revision", verdict: "approve", isOtherDraftsRevision: false },
  { name: "another Draft's Revision", verdict: "approve", isOtherDraftsRevision: true },
  { name: "another Draft's Revision", verdict: "reject", isOtherDraftsRevision: true },
] as const)(
  "a verdict ($verdict) on $name answers with 404 REVISION_NOT_FOUND and changes nothing",
  async ({ verdict, isOtherDraftsRevision }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const submitted = await createSubmittedDraft(worker);
    const other = await createSubmittedDraft(worker);
    const rowsBefore = await readRows(worker);

    const response = await renderVerdict(
      worker,
      verdict,
      submitted.id,
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
    expect(await readSentSendQueueMessages(worker)).toStrictEqual([]);
  },
);

test.for([
  { name: "approving", verdict: "approve" },
  { name: "rejecting", verdict: "reject" },
] as const)(
  "$name a Revision of an unknown Draft answers with 404 DRAFT_NOT_FOUND",
  async ({ verdict }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const submitted = await createSubmittedDraft(worker);
    const rowsBefore = await readRows(worker);

    const response = await renderVerdict(
      worker,
      verdict,
      UNKNOWN_DRAFT_ID,
      submitted.latestRevision.id,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "DRAFT_NOT_FOUND", message: "No Draft has this id." },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test("approving by a Draft id as Revision id answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);

  const response = await approve(worker, submitted.id, submitted.id);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "INVALID_REQUEST", issues: [{ path: ["revisionId"] }] },
  });
});

test.for([
  { name: "its approved Revision", isApprovedRevisionTheBase: true },
  { name: "a Superseded Revision", isApprovedRevisionTheBase: false },
])(
  "after an Approval, revising on $name answers with 409 DRAFT_APPROVED and changes nothing",
  async ({ isApprovedRevisionTheBase }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const revised = await expectRevised(worker, created.id, created.latestRevision.id);
    await expectSubmitted(worker, created.id, revised.latestRevision.id);
    await expectVerdict(worker, "approve", created.id, revised.latestRevision.id);
    const rowsBefore = await readRows(worker);

    const response = await reviseDraft(
      worker,
      created.id,
      isApprovedRevisionTheBase ? revised.latestRevision.id : created.latestRevision.id,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "DRAFT_APPROVED" } });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test("after an Approval, submitting its approved Revision answers with 409 DRAFT_APPROVED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  await expectVerdict(worker, "approve", submitted.id, submitted.latestRevision.id);
  const rowsBefore = await readRows(worker);

  const response = await submitRevision(worker, submitted.id, submitted.latestRevision.id);

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "DRAFT_APPROVED" } });
  expect(await readRows(worker)).toStrictEqual(rowsBefore);
});

test("after a Rejection, the Agent revises on the Rejected Revision and still sees the reason in lastVerdict, through Submission and Approval", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const rejectedRevisionId = submitted.latestRevision.id;
  const rejected = await expectVerdict(worker, "reject", submitted.id, rejectedRevisionId, {
    reason: "Wrong recipient",
  });

  const revised = await expectRevised(worker, submitted.id, rejectedRevisionId);
  const resubmitted = await expectSubmitted(worker, submitted.id, revised.latestRevision.id);
  const draftResponse = await worker.fetch(`/api/v1/drafts/${submitted.id}`, {
    headers: AGENT_HEADERS,
  });
  const draft: unknown = await draftResponse.json();
  const rejectedRevisionResponse = await worker.fetch(
    `/api/v1/drafts/${submitted.id}/revisions/${rejectedRevisionId}`,
    { headers: AGENT_HEADERS },
  );
  const rejectedRevision: unknown = await rejectedRevisionResponse.json();
  const approved = await expectVerdict(worker, "approve", submitted.id, revised.latestRevision.id);

  const rejection = {
    revisionId: rejectedRevisionId,
    revisionNumber: 1,
    verdict: "REJECTED",
    reason: "Wrong recipient",
    decidedAt: rejected.lastActionAt,
  };
  expect(revised).toMatchObject({
    reviewStatus: "UNSUBMITTED",
    latestRevision: { revisionNumber: 2 },
    lastVerdict: rejection,
  });
  expect(resubmitted).toMatchObject({ reviewStatus: "PENDING", lastVerdict: rejection });
  expect(draft).toMatchObject({ reviewStatus: "PENDING", lastVerdict: rejection });
  expect(rejectedRevision).toMatchObject({
    reviewStatus: "REJECTED",
    rejectionReason: "Wrong recipient",
  });
  expect(approved).toMatchObject({
    reviewStatus: "APPROVED",
    lastVerdict: {
      revisionId: revised.latestRevision.id,
      revisionNumber: 2,
      verdict: "APPROVED",
      decidedAt: approved.lastActionAt,
    },
    sending: { status: "QUEUED" },
  });
  expect(approved.lastVerdict).not.toHaveProperty("reason");
  expect(await readSentSendQueueMessages(worker)).toMatchObject([
    { outgoingEmail: { to: REVISED_DRAFT_DATA.to, subject: REVISED_DRAFT_DATA.subject } },
  ]);
});

test("a Draft without a verdict has no lastVerdict", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);

  const draft = await worker.fetch(`/api/v1/drafts/${submitted.id}`, { headers: AGENT_HEADERS });

  expect(submitted).not.toHaveProperty("lastVerdict");
  expect(await draft.json()).not.toHaveProperty("lastVerdict");
});

test("10 concurrent Approvals of the same Revision: one 200, nine 409 REVISION_ALREADY_DECIDED and exactly one Send Queue message", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => approve(worker, submitted.id, submitted.latestRevision.id)),
  );

  const outcomes = await readOutcomes(responses);
  expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status !== 200)).toStrictEqual(
    Array.from({ length: 9 }, () => ({
      status: 409,
      code: "REVISION_ALREADY_DECIDED",
      existingVerdict: "APPROVED",
    })),
  );
  expect(await readSentSendQueueMessages(worker)).toMatchObject([{ draftId: submitted.id }]);
  // The losers changed nothing: the rows hold exactly the winner's Approval.
  const winner = draftSummarySchema.parse(
    bodyOf(outcomes.find((outcome) => outcome.status === 200)),
  );
  const decidedAt = Temporal.Instant.from(winner.lastActionAt).epochMilliseconds;
  expect(await readRows(worker)).toMatchObject({
    drafts: [{ sending_status: "QUEUED", approved_at: decidedAt, last_action_at: decidedAt }],
    revisions: [{ review_status: "APPROVED", decided_at: decidedAt }],
  });
});

test("5 concurrent Approvals and 5 concurrent Rejections of the same Revision: one verdict, nine 409 REVISION_ALREADY_DECIDED naming it, and a Send Queue message only for an Approval", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const revisionId = submitted.latestRevision.id;

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0
        ? approve(worker, submitted.id, revisionId)
        : reject(worker, submitted.id, revisionId, { reason: "Wrong recipient" }),
    ),
  );

  const outcomes = await readOutcomes(responses);
  const winners = outcomes.filter((outcome) => outcome.status === 200);
  expect(winners).toHaveLength(1);
  const winner = draftSummarySchema.parse(bodyOf(winners[0]));
  const verdict = winner.reviewStatus;
  expect(outcomes.filter((outcome) => outcome.status !== 200)).toStrictEqual(
    Array.from({ length: 9 }, () => ({
      status: 409,
      code: "REVISION_ALREADY_DECIDED",
      existingVerdict: verdict,
    })),
  );
  expect(await readSentSendQueueMessages(worker)).toHaveLength(verdict === "APPROVED" ? 1 : 0);
  const decidedAt = Temporal.Instant.from(winner.lastActionAt).epochMilliseconds;
  expect(await readRows(worker)).toMatchObject({
    drafts: [
      {
        sending_status: verdict === "APPROVED" ? "QUEUED" : "NOT_SENT",
        last_action_at: decidedAt,
      },
    ],
    revisions: [{ review_status: verdict, decided_at: decidedAt }],
  });
});

test("5 concurrent Approvals and 5 concurrent revises on the same base: the first commit decides, and every other request gets the matching 409", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const revisionId = submitted.latestRevision.id;

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0
        ? approve(worker, submitted.id, revisionId)
        : reviseDraft(worker, submitted.id, revisionId),
    ),
  );

  const outcomes = await readOutcomes(responses);
  const approvals = outcomes.filter((_, index) => index % 2 === 0).map(toStatusAndCode);
  const revises = outcomes.filter((_, index) => index % 2 === 1).map(toStatusAndCode);
  const isApprovalFirst = approvals.some((outcome) => outcome.status === 200);
  const observed = {
    approvals: approvals.toSorted(byStatusAndCode),
    revises: revises.toSorted(byStatusAndCode),
    sentMessages: (await readSentSendQueueMessages(worker)).length,
    ...(await readRows(worker)),
  };
  // Approval first: every revise finds the Draft approved, every other Approval the verdict.
  // Revise first: every Approval finds its Revision superseded, every other revise the new base.
  expect(observed).toMatchObject(
    isApprovalFirst
      ? {
          approvals: [
            { status: 200 },
            ...repeat(4, { status: 409, code: "REVISION_ALREADY_DECIDED:APPROVED" }),
          ],
          revises: repeat(5, { status: 409, code: "DRAFT_APPROVED" }),
          sentMessages: 1,
          drafts: [{ sending_status: "QUEUED", latest_revision_id: revisionId }],
          revisions: [{ id: revisionId, review_status: "APPROVED" }],
        }
      : {
          approvals: repeat(5, { status: 409, code: "REVISION_SUPERSEDED" }),
          revises: [{ status: 201 }, ...repeat(4, { status: 409, code: "REVISION_SUPERSEDED" })],
          sentMessages: 0,
          drafts: [{ sending_status: "NOT_SENT" }],
          revisions: [
            { id: revisionId, review_status: "SUPERSEDED", decided_at: null },
            { revision_number: 2, review_status: "UNSUBMITTED" },
          ],
        },
  );
  expect(observed.revisions).toHaveLength(isApprovalFirst ? 1 : 2);
});

test("5 concurrent Rejections and 5 concurrent revises on the same base: the first commit decides, and the outcomes match its order", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const submitted = await createSubmittedDraft(worker);
  const revisionId = submitted.latestRevision.id;

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0
        ? reject(worker, submitted.id, revisionId, { reason: "Wrong recipient" })
        : reviseDraft(worker, submitted.id, revisionId),
    ),
  );

  const outcomes = await readOutcomes(responses);
  const rejections = outcomes.filter((_, index) => index % 2 === 0).map(toStatusAndCode);
  const revises = outcomes.filter((_, index) => index % 2 === 1).map(toStatusAndCode);
  const isRejectionFirst = rejections.some((outcome) => outcome.status === 200);
  const observed = {
    winningRejections: rejections.filter((outcome) => outcome.status === 200).length,
    // A losing Rejection that commits after the Rejection finds the verdict; one that commits after
    // the successful revise finds its Revision superseded.
    losingRejectionCodes: [
      ...new Set(rejections.filter((outcome) => outcome.status !== 200).map(({ code }) => code)),
    ],
    // After a Rejection, the revise builds on the Rejected Revision, so one revise succeeds either way.
    revises: revises.toSorted(byStatusAndCode),
    sentMessages: (await readSentSendQueueMessages(worker)).length,
    revisions: (await readRows(worker)).revisions,
  };
  expect(observed).toMatchObject({
    winningRejections: isRejectionFirst ? 1 : 0,
    revises: [{ status: 201 }, ...repeat(4, { status: 409, code: "REVISION_SUPERSEDED" })],
    sentMessages: 0,
    revisions: [
      isRejectionFirst
        ? { id: revisionId, review_status: "REJECTED", rejection_reason: "Wrong recipient" }
        : { id: revisionId, review_status: "SUPERSEDED", decided_at: null },
      { revision_number: 2, review_status: "UNSUBMITTED" },
    ],
  });
  expect(observed.revisions).toHaveLength(2);
  expect(
    isRejectionFirst
      ? ["REVISION_ALREADY_DECIDED:REJECTED", "REVISION_SUPERSEDED"]
      : ["REVISION_SUPERSEDED"],
  ).toStrictEqual(expect.arrayContaining(observed.losingRejectionCodes));
});

type VerdictAction = "approve" | "reject";

type Outcome =
  | { status: number; body: unknown }
  | { status: number; code: string; existingVerdict?: string };

async function createDraft(worker: TestWorker): Promise<DraftSummaryResponse> {
  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify(DRAFT_DATA),
  });
  return draftSummarySchema.parse(await response.json());
}

/** Creates a Draft and submits its first Revision, so that it awaits a verdict. */
async function createSubmittedDraft(worker: TestWorker): Promise<DraftSummaryResponse> {
  const created = await createDraft(worker);
  return expectSubmitted(worker, created.id, created.latestRevision.id);
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

async function approve(worker: TestWorker, draftId: string, revisionId: string) {
  return worker.fetch(`/api/v1/drafts/${draftId}/revisions/${revisionId}/approval`, {
    method: "POST",
    headers: { Authorization: REVIEWER_AUTHORIZATION },
  });
}

/** Rejects the Revision, sending `body` as JSON; without `body` the request has none. */
async function reject(worker: TestWorker, draftId: string, revisionId: string, body?: unknown) {
  return worker.fetch(`/api/v1/drafts/${draftId}/revisions/${revisionId}/rejection`, {
    method: "POST",
    headers:
      body === undefined
        ? { Authorization: REVIEWER_AUTHORIZATION }
        : { Authorization: REVIEWER_AUTHORIZATION, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function renderVerdict(
  worker: TestWorker,
  verdict: VerdictAction,
  draftId: string,
  revisionId: string,
  rejection?: { reason: string },
) {
  return verdict === "approve"
    ? approve(worker, draftId, revisionId)
    : reject(worker, draftId, revisionId, rejection ?? {});
}

/** Approves or rejects the Revision and fails the test unless the verdict is recorded. */
async function expectVerdict(
  worker: TestWorker,
  verdict: VerdictAction,
  draftId: string,
  revisionId: string,
  rejection?: { reason: string },
): Promise<DraftSummaryResponse> {
  const response = await renderVerdict(worker, verdict, draftId, revisionId, rejection);
  if (response.status !== 200) {
    throw new Error(`The ${verdict} answered with ${response.status}: ${await response.text()}`);
  }
  return draftSummarySchema.parse(await response.json());
}

/** Reads each response as its status with the body of a success or the code of an error. */
async function readOutcomes(
  responses: Awaited<ReturnType<TestWorker["fetch"]>>[],
): Promise<Outcome[]> {
  return Promise.all(
    responses.map(async (response): Promise<Outcome> => {
      const body: unknown = await response.json();
      if (response.status === 200 || response.status === 201) {
        return { status: response.status, body };
      }
      const { error } = errorResponseSchema.parse(body);
      return {
        status: response.status,
        code: error.code,
        ...(error.existingVerdict === undefined ? {} : { existingVerdict: error.existingVerdict }),
      };
    }),
  );
}

/** The body of a successful outcome. */
function bodyOf(outcome: Outcome | undefined): unknown {
  return outcome !== undefined && "body" in outcome ? outcome.body : undefined;
}

/** Reduces an outcome to its status and, for an error, its code with any `existingVerdict`. */
function toStatusAndCode(outcome: Outcome): { status: number; code?: string } {
  if (!("code" in outcome)) {
    return { status: outcome.status };
  }
  const existingVerdict =
    outcome.existingVerdict === undefined ? "" : `:${outcome.existingVerdict}`;
  return { status: outcome.status, code: `${outcome.code}${existingVerdict}` };
}

/** Orders outcomes by status, then code, so that a test can compare them regardless of timing. */
function byStatusAndCode(
  first: { status: number; code?: string },
  second: { status: number; code?: string },
): number {
  return first.status - second.status || (first.code ?? "").localeCompare(second.code ?? "");
}

function repeat<T>(count: number, value: T): T[] {
  return Array.from({ length: count }, () => value);
}

async function readRows(worker: TestWorker) {
  const env = await worker.getEnv();
  const [drafts, revisions] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM drafts ORDER BY id"),
    env.DB.prepare("SELECT * FROM revisions ORDER BY draft_id, revision_number"),
  ]);
  return { drafts: drafts?.results, revisions: revisions?.results };
}
