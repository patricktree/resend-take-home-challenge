/*
 * The Send outbox on the Draft row after the Approval batch (spec section 9): every later write and
 * query of the Send's columns. The Approval batch itself freezes the outbox, since that statement
 * must carry the verdict guard (spec section 8).
 *
 * Every write is conditional on the row. The hand-off is recorded only while the Send is `QUEUED`
 * without `enqueued_at`. Of the outcomes (spec section 9, "Recording outcomes"), the first final one
 * wins, except that a late `SENT` overrides `OUTCOME_UNKNOWN`. No write sets `last_action_at`.
 */

import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import assert from "node:assert/strict";
import { Temporal } from "temporal-polyfill";

import type { DraftId } from "../domain/ids.ts";
import { sendQueueMessageSchema, type SendQueueMessage } from "../domain/send-queue-message.ts";
import { drafts } from "./schema.ts";

export type SendFailure =
  /** Resend refused the request: the email definitely did not go out. */
  | { reason: "REJECTED_BY_RESEND"; resendErrorName?: string; resendErrorMessage?: string }
  /** The Send ended without an answer from Resend: the email may have gone out. */
  | { reason: "OUTCOME_UNKNOWN" };

/**
 * `sending_status = 'QUEUED'` with the value inlined: SQLite uses a partial index only when the
 * query's terms imply the index's `WHERE` as written, and `eq()` would bind the value as a
 * parameter, which implies nothing.
 */
const IS_QUEUED = sql`${drafts.sendingStatus} = 'QUEUED'`;

/**
 * Records that the Sends' Queue messages have been sent: sets `enqueued_at` on each Draft that is
 * still `QUEUED` without one, so a Send that ended or was recorded in the meantime keeps its row.
 * One statement per Draft, in one batch: D1 binds at most 100 parameters per statement.
 */
export async function recordHandOff(
  database: DrizzleD1Database,
  draftIds: DraftId[],
): Promise<void> {
  const enqueuedAt = Temporal.Now.instant().epochMilliseconds;
  const [firstUpdate, ...otherUpdates] = draftIds.map((draftId) =>
    database
      .update(drafts)
      .set({ enqueuedAt })
      .where(
        and(eq(drafts.id, draftId), eq(drafts.sendingStatus, "QUEUED"), isNull(drafts.enqueuedAt)),
      ),
  );
  assert(firstUpdate !== undefined, "A hand-off names at least one Send.");
  await database.batch([firstUpdate, ...otherUpdates]);
}

/**
 * Whether the Draft's Send has ended, `SENT` or `FAILED` with either reason. Throws when the Draft
 * has no row, which a Send intent's Draft always has.
 */
export async function hasSendEnded(
  database: DrizzleD1Database,
  draftId: DraftId,
): Promise<boolean> {
  const [row] = await database
    .select({ sendingStatus: drafts.sendingStatus })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  if (row === undefined) {
    throw new Error(`The Draft ${draftId} of a Send intent has no row.`);
  }
  return row.sendingStatus === "SENT" || row.sendingStatus === "FAILED";
}

/**
 * Records `SENT` with Resend's email id, when the Send is still `QUEUED` or ended as `FAILED` /
 * `OUTCOME_UNKNOWN` (then clearing the failure); otherwise changes nothing.
 */
export async function recordSent(
  database: DrizzleD1Database,
  draftId: DraftId,
  emailId: string,
): Promise<void> {
  await database
    .update(drafts)
    .set({
      sendingStatus: "SENT",
      emailId,
      failureReason: null,
      resendErrorName: null,
      resendErrorMessage: null,
    })
    .where(
      and(
        eq(drafts.id, draftId),
        or(
          eq(drafts.sendingStatus, "QUEUED"),
          and(eq(drafts.sendingStatus, "FAILED"), eq(drafts.failureReason, "OUTCOME_UNKNOWN")),
        ),
      ),
    );
}

/** Records `FAILED` with the failure, when the Send is still `QUEUED`; otherwise changes nothing. */
export async function recordFailed(
  database: DrizzleD1Database,
  draftId: DraftId,
  failure: SendFailure,
): Promise<void> {
  await database
    .update(drafts)
    .set({
      sendingStatus: "FAILED",
      failureReason: failure.reason,
      resendErrorName:
        failure.reason === "REJECTED_BY_RESEND" ? (failure.resendErrorName ?? null) : null,
      resendErrorMessage:
        failure.reason === "REJECTED_BY_RESEND" ? (failure.resendErrorMessage ?? null) : null,
    })
    .where(and(eq(drafts.id, draftId), eq(drafts.sendingStatus, "QUEUED")));
}

/**
 * The Send intents of the approved Sends whose hand-off was never recorded, approved before
 * `approvedBefore`, oldest first, at most `limit`. The conditions and the order match the partial
 * index `drafts_queued_not_enqueued_approved_at_index`.
 */
export async function findLostHandOffs(
  database: DrizzleD1Database,
  approvedBefore: number,
  limit: number,
): Promise<SendQueueMessage[]> {
  const rows = await database
    .select()
    .from(drafts)
    .where(and(IS_QUEUED, isNull(drafts.enqueuedAt), lt(drafts.approvedAt, approvedBefore)))
    .orderBy(asc(drafts.approvedAt))
    .limit(limit);
  return rows.map(toSendQueueMessage);
}

/**
 * The Drafts of the Sends still `QUEUED` whose deadline is before `deadlineBefore`, the earliest
 * deadline first, at most `limit`. The conditions and the order match the partial index
 * `drafts_queued_deadline_index`.
 */
export async function findExpiredSends(
  database: DrizzleD1Database,
  deadlineBefore: number,
  limit: number,
): Promise<DraftId[]> {
  const rows = await database
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(IS_QUEUED, lt(drafts.deadline, deadlineBefore)))
    .orderBy(asc(drafts.deadline))
    .limit(limit);
  return rows.map(({ id }) => id);
}

/**
 * Builds the Send Queue message of an approved Draft from its frozen outbox columns. Throws when
 * the outbox is incomplete or malformed, which the `CHECK` constraints of `drafts` rule out.
 */
export function toSendQueueMessage(draftRow: typeof drafts.$inferSelect): SendQueueMessage {
  return sendQueueMessageSchema.parse({
    draftId: draftRow.id,
    idempotencyKey: draftRow.idempotencyKey,
    outgoingEmail: draftRow.outgoingEmail,
    deadline: draftRow.deadline,
  });
}
