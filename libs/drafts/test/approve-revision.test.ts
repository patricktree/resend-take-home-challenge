import { Temporal } from "temporal-polyfill";
import { test, vi } from "vitest";

import { approveRevision } from "#src/approve-revision.ts";
import { createDraft } from "#src/create-draft.ts";
import { drizzleForSession, type DraftsStorage } from "#src/database.ts";
import { rejectRevision } from "#src/reject-revision.ts";
import { reviseDraft } from "#src/revise-draft.ts";
import { sendQueueMessageSchema } from "#src/send-queue.ts";
import { submitRevision } from "#src/submit-revision.ts";

import { createGatedD1Database } from "#test/gated-d1-database.ts";
import { createFailingSendQueue, createRecordingSendQueue } from "#test/recording-send-queue.ts";
import { useBindings, type TestBindings } from "#test/use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com", "grace@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

const RESEND_FROM = "drafts@resend-challenge.patricktree.me";

const DEADLINE_AFTER_APPROVAL_MILLISECONDS = 23 * 60 * 60 * 1000;

test("an Approval freezes the outbox, hands exactly one Send intent to the Send Queue and records the hand-off", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const storage = storageOn(bindings.DB, bindings);
  const sendQueue = createRecordingSendQueue();
  const created = await createDraft(storage, DRAFT_DATA);
  const draftId = created.id;
  const revisionId = created.latestRevision.id;
  await submitRevision(storage, draftId, revisionId);

  const before = Temporal.Now.instant().epochMilliseconds;
  const result = await approveRevision(
    storage,
    { sendQueue, from: RESEND_FROM },
    draftId,
    revisionId,
  );
  const after = Temporal.Now.instant().epochMilliseconds;

  const { drafts, revisions } = await readRows(bindings.DB);
  const [draftRow] = drafts ?? [];
  const approvedAt = Number(draftRow?.["approved_at"]);
  expect(approvedAt).toBeGreaterThanOrEqual(before);
  expect(approvedAt).toBeLessThanOrEqual(after);
  const outgoingEmail = {
    from: RESEND_FROM,
    to: DRAFT_DATA.to,
    subject: DRAFT_DATA.subject,
    bodyKey: `revisions/${revisionId}/body`,
    tags: [{ name: "draft_id", value: draftId }],
  };
  const approvedAtInstant = Temporal.Instant.fromEpochMilliseconds(approvedAt);
  expect(result).toStrictEqual({
    outcome: "APPROVED",
    draft: {
      ...created,
      lastActionAt: approvedAtInstant,
      latestRevision: {
        ...created.latestRevision,
        reviewStatus: "APPROVED",
        submittedAt: expect.any(Temporal.Instant),
        decidedAt: approvedAtInstant,
      },
      lastVerdict: {
        revisionId,
        revisionNumber: 1,
        verdict: "APPROVED",
        decidedAt: approvedAtInstant,
      },
      sending: { status: "QUEUED" },
    },
  });
  expect(sendQueue.sentMessages).toStrictEqual([
    {
      draftId,
      idempotencyKey: `draft-send/${draftId}`,
      outgoingEmail,
      deadline: approvedAt + DEADLINE_AFTER_APPROVAL_MILLISECONDS,
    },
  ]);
  expect(sendQueueMessageSchema.parse(sendQueue.sentMessages[0])).toStrictEqual(
    sendQueue.sentMessages[0],
  );
  expect(draftRow).toMatchObject({
    sending_status: "QUEUED",
    approved_revision_id: revisionId,
    idempotency_key: `draft-send/${draftId}`,
    deadline: approvedAt + DEADLINE_AFTER_APPROVAL_MILLISECONDS,
    last_action_at: approvedAt,
    enqueued_at: expect.any(Number),
  });
  expect(JSON.parse(String(draftRow?.["outgoing_email"]))).toStrictEqual(outgoingEmail);
  expect(Number(draftRow?.["enqueued_at"])).toBeGreaterThanOrEqual(approvedAt);
  expect(revisions).toMatchObject([
    { id: revisionId, review_status: "APPROVED", decided_at: approvedAt, rejection_reason: null },
  ]);
});

test("a failed hand-off to the Send Queue does not fail the Approval: the Draft is QUEUED without enqueued_at and the root cause is logged", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const storage = storageOn(bindings.DB, bindings);
  const created = await createDraft(storage, DRAFT_DATA);
  await submitRevision(storage, created.id, created.latestRevision.id);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => consoleError.mockRestore());

  const result = await approveRevision(
    storage,
    { sendQueue: createFailingSendQueue("Queue unavailable"), from: RESEND_FROM },
    created.id,
    created.latestRevision.id,
  );

  expect(result).toMatchObject({
    outcome: "APPROVED",
    draft: { latestRevision: { reviewStatus: "APPROVED" }, sending: { status: "QUEUED" } },
  });
  const { drafts } = await readRows(bindings.DB);
  expect(drafts).toMatchObject([
    {
      sending_status: "QUEUED",
      approved_revision_id: created.latestRevision.id,
      outgoing_email: expect.any(String),
      enqueued_at: null,
    },
  ]);
  expect(consoleError).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Queue unavailable"),
  );
});

test("approve ‖ approve: the Approval whose batch commits second gets REVISION_ALREADY_DECIDED with APPROVED, changes nothing and enqueues nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const sendQueue = createRecordingSendQueue();
  const sendHandOff = { sendQueue, from: RESEND_FROM };
  const created = await createSubmittedDraft(bindings);
  const revisionId = created.latestRevision.id;

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldApproval = approveRevision(
    storageOn(gatedDatabase.database, bindings),
    sendHandOff,
    created.id,
    revisionId,
  );
  await gate.reached;
  const committedApproval = await approveRevision(
    storageOn(bindings.DB, bindings),
    sendHandOff,
    created.id,
    revisionId,
  );
  const rowsAfterCommittedApproval = await readRows(bindings.DB);
  gate.release();

  expect(committedApproval).toMatchObject({
    outcome: "APPROVED",
    draft: { sending: { status: "QUEUED" } },
  });
  expect(await heldApproval).toStrictEqual({
    outcome: "REVISION_ALREADY_DECIDED",
    existingVerdict: "APPROVED",
  });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedApproval);
  expect(sendQueue.sentMessages).toMatchObject([{ draftId: created.id }]);
});

test("approve ‖ reject, reject first: the Approval gets REVISION_ALREADY_DECIDED with REJECTED, changes nothing and enqueues nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const sendQueue = createRecordingSendQueue();
  const created = await createSubmittedDraft(bindings);
  const revisionId = created.latestRevision.id;

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldApproval = approveRevision(
    storageOn(gatedDatabase.database, bindings),
    { sendQueue, from: RESEND_FROM },
    created.id,
    revisionId,
  );
  await gate.reached;
  const committedRejection = await rejectRevision(
    storageOn(bindings.DB, bindings),
    created.id,
    revisionId,
    { reason: "Wrong recipient" },
  );
  const rowsAfterCommittedRejection = await readRows(bindings.DB);
  gate.release();

  expect(committedRejection).toMatchObject({ outcome: "REJECTED" });
  expect(await heldApproval).toStrictEqual({
    outcome: "REVISION_ALREADY_DECIDED",
    existingVerdict: "REJECTED",
  });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedRejection);
  expect(rowsAfterCommittedRejection.drafts).toMatchObject([
    { sending_status: "NOT_SENT", outgoing_email: null },
  ]);
  expect(sendQueue.sentMessages).toStrictEqual([]);
});

test("approve ‖ reject, approve first: the Rejection gets REVISION_ALREADY_DECIDED with APPROVED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const sendQueue = createRecordingSendQueue();
  const created = await createSubmittedDraft(bindings);
  const revisionId = created.latestRevision.id;

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldRejection = rejectRevision(
    storageOn(gatedDatabase.database, bindings),
    created.id,
    revisionId,
    { reason: "Wrong recipient" },
  );
  await gate.reached;
  const committedApproval = await approveRevision(
    storageOn(bindings.DB, bindings),
    { sendQueue, from: RESEND_FROM },
    created.id,
    revisionId,
  );
  const rowsAfterCommittedApproval = await readRows(bindings.DB);
  gate.release();

  expect(committedApproval).toMatchObject({ outcome: "APPROVED" });
  expect(await heldRejection).toStrictEqual({
    outcome: "REVISION_ALREADY_DECIDED",
    existingVerdict: "APPROVED",
  });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedApproval);
  expect(rowsAfterCommittedApproval.revisions).toMatchObject([
    { review_status: "APPROVED", rejection_reason: null },
  ]);
  expect(sendQueue.sentMessages).toHaveLength(1);
});

test("approve ‖ revise, revise first: the Approval gets REVISION_SUPERSEDED, changes nothing and enqueues nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const sendQueue = createRecordingSendQueue();
  const created = await createSubmittedDraft(bindings);

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldApproval = approveRevision(
    storageOn(gatedDatabase.database, bindings),
    { sendQueue, from: RESEND_FROM },
    created.id,
    created.latestRevision.id,
  );
  await gate.reached;
  const committedRevise = await reviseDraft(storageOn(bindings.DB, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Committed revise",
    baseRevisionId: created.latestRevision.id,
  });
  const rowsAfterCommittedRevise = await readRows(bindings.DB);
  gate.release();

  expect(committedRevise).toMatchObject({ outcome: "REVISED" });
  expect(await heldApproval).toStrictEqual({ outcome: "REVISION_SUPERSEDED" });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedRevise);
  expect(rowsAfterCommittedRevise.drafts).toMatchObject([{ sending_status: "NOT_SENT" }]);
  expect(sendQueue.sentMessages).toStrictEqual([]);
});

/** Creates a Draft and submits its first Revision, so that it awaits a verdict. */
async function createSubmittedDraft(bindings: TestBindings) {
  const storage = storageOn(bindings.DB, bindings);
  const created = await createDraft(storage, DRAFT_DATA);
  const submitted = await submitRevision(storage, created.id, created.latestRevision.id);
  if (submitted.outcome !== "SUBMITTED") {
    throw new Error(`The Submission ended with ${submitted.outcome}.`);
  }
  return submitted.draft;
}

function storageOn(database: D1Database, bindings: TestBindings): DraftsStorage {
  return {
    database: drizzleForSession(database, "first-primary").database,
    revisionBodies: bindings.REVISION_BODIES,
  };
}

async function readRows(database: D1Database) {
  const [drafts, revisions] = await database.batch<Record<string, unknown>>([
    database.prepare("SELECT * FROM drafts ORDER BY id"),
    database.prepare("SELECT * FROM revisions ORDER BY draft_id, revision_number"),
  ]);
  return { drafts: drafts?.results, revisions: revisions?.results };
}
