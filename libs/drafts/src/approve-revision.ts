import { and, eq, isNull, sql } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import type { DraftsStorage } from "#src/database.ts";
import type { DraftSummary } from "#src/draft.ts";
import { toDraftSummary } from "#src/draft.ts";
import { isDraftId, isRevisionId, type DraftId } from "#src/ids.ts";
import { revisionBodyKey } from "#src/revision-bodies.ts";
import { findRootCauseMessage } from "#src/root-cause.ts";
import { drafts, revisions } from "#src/schema.ts";
import { computeSendDeadline } from "#src/send-deadline.ts";
import { toSendQueueMessage, type SendQueue } from "#src/send-queue.ts";
import { explainVerdictRefusal, isLatestAndPending, type VerdictRefusal } from "#src/verdicts.ts";

/** Where an Approval hands its Send intent, and the sender it freezes into the outgoing email. */
export type SendHandOff = {
  sendQueue: SendQueue;
  /** `RESEND_FROM`, resolved when the Approval is recorded; not part of what the Reviewer approves. */
  from: string;
};

export type ApproveRevisionResult = { outcome: "APPROVED"; draft: DraftSummary } | VerdictRefusal;

/**
 * Approves one Revision, the Draft's latest and `PENDING`, and records the Draft's one Send intent:
 * the Draft becomes `QUEUED` with its outbox frozen (approved Revision, idempotency key, outgoing
 * email, deadline).
 *
 * Runs one guarded batch (spec section 8): every statement carries the guard "the Revision is the
 * Draft's latest and `PENDING`", and the statement that makes it false runs last, so only one
 * verdict per Revision and only one Approval per Draft ever commits, and a losing Approval writes
 * nothing. After the commit it hands the Send intent to the Send Queue and records the hand-off in
 * `enqueued_at`. A failed hand-off never fails the Approval: it is logged, `enqueued_at` stays
 * unset, and the Send reconciler re-enqueues it. Writes, so the database session must start with
 * `"first-primary"`.
 */
export async function approveRevision(
  { database }: DraftsStorage,
  { sendQueue, from }: SendHandOff,
  draftId: string,
  revisionId: string,
): Promise<ApproveRevisionResult> {
  if (!isDraftId(draftId)) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (!isRevisionId(revisionId)) {
    return { outcome: "REVISION_NOT_FOUND" };
  }
  // Checked before anything is written: a committed Approval without a sender could never be sent.
  if (from === "") {
    throw new Error("RESEND_FROM is not configured.");
  }

  const approvedAt = Temporal.Now.instant();
  const now = approvedAt.epochMilliseconds;

  // `to` and `subject` come from the approved Revision, which is immutable.
  const outgoingEmail = sql`(
    SELECT json_object(
      'from', ${from},
      'to', json(${revisions.toAddresses}),
      'subject', ${revisions.subject},
      'bodyKey', ${revisionBodyKey(revisionId)},
      'tags', json_array(json_object('name', 'draft_id', 'value', ${draftId}))
    )
    FROM ${revisions}
    WHERE ${revisions.id} = ${revisionId}
  )`;
  const guard = isLatestAndPending(database, draftId, revisionId);
  const [updatedDrafts, updatedRevisions] = await database.batch([
    database
      .update(drafts)
      .set({
        sendingStatus: "QUEUED",
        approvedRevisionId: revisionId,
        approvedAt: now,
        idempotencyKey: `draft-send/${draftId}`,
        outgoingEmail,
        deadline: computeSendDeadline(approvedAt),
        lastActionAt: now,
      })
      .where(and(eq(drafts.id, draftId), guard))
      .returning(),
    // Leaving `PENDING` makes the guard false, so this statement runs last.
    database
      .update(revisions)
      .set({ reviewStatus: "APPROVED", decidedAt: now })
      .where(and(eq(revisions.id, revisionId), guard))
      .returning(),
  ]);

  const [draftRow] = updatedDrafts;
  const [revisionRow] = updatedRevisions;
  if (draftRow === undefined || revisionRow === undefined) {
    return explainVerdictRefusal(database, draftId, revisionId);
  }

  await handOffSend(database, sendQueue, draftRow);

  // The approved Revision is the latest one, so its verdict is the Draft's last verdict.
  return { outcome: "APPROVED", draft: toDraftSummary(draftRow, revisionRow, revisionRow) };
}

/**
 * Sends the Draft's Send intent, built from the frozen outbox columns, to the Send Queue, then sets
 * `enqueued_at` unless the Send reconciler did already. Logs a failure and returns, since the
 * Approval has committed and the reconciler re-enqueues every Send without `enqueued_at`.
 */
async function handOffSend(
  database: DraftsStorage["database"],
  sendQueue: SendQueue,
  draftRow: typeof drafts.$inferSelect,
): Promise<void> {
  const draftId: DraftId = draftRow.id;
  const message = toSendQueueMessage(draftRow);

  // Only root causes' messages are logged: wrapping errors such as Drizzle's carry SQL parameters.
  try {
    await sendQueue.send(message);
  } catch (error) {
    console.error(
      `Sending the Send of Draft ${draftId} to the Send Queue failed; the Send reconciler re-enqueues it. ${findRootCauseMessage(error)}`,
    );
    return;
  }

  try {
    await database
      .update(drafts)
      .set({ enqueuedAt: Temporal.Now.instant().epochMilliseconds })
      .where(
        and(eq(drafts.id, draftId), eq(drafts.sendingStatus, "QUEUED"), isNull(drafts.enqueuedAt)),
      );
  } catch (error) {
    console.error(
      `Recording the Send Queue hand-off of Draft ${draftId} failed; the Send reconciler re-enqueues it, and the idempotency key absorbs the duplicate. ${findRootCauseMessage(error)}`,
    );
  }
}
