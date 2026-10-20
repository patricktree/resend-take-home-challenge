/*
 * The Send reconciler (spec section 9, "Send reconciler"): the cron trigger runs it every minute so
 * that no Send stays `QUEUED` forever. Each tick runs two bounded jobs, each on at most 100 rows,
 * oldest first, along its partial index of `drafts`:
 *
 * 1. Lost hand-off: re-enqueues the Sends whose Queue message was never recorded as sent.
 * 2. Backstop: resolves the Sends still `QUEUED` an hour after their deadline.
 *
 * Duplicates (a request that died between `send()` and setting `enqueued_at`, overlapping ticks)
 * are absorbed by the idempotency key, under which every attempt sends the same frozen body.
 */

import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Temporal } from "temporal-polyfill";

import { findRootCauseMessage } from "#src/root-cause.ts";
import { drafts } from "#src/schema.ts";
import { recordFailed } from "#src/send-outcomes.ts";
import { toSendQueueMessage, type SendQueue } from "#src/send-queue.ts";

/** Where the Send reconciler reads and records Sends, and where it re-enqueues them. */
export type SendReconcilerDependencies = {
  /** A database session that starts with `"first-primary"`, since both jobs write. */
  database: DrizzleD1Database;
  sendQueue: SendQueue;
};

/** The most rows each job handles per tick; later ticks drain a larger backlog. */
const ROWS_PER_JOB_AND_TICK = 100;

/**
 * How long an approved Send may go without a recorded hand-off before the reconciler re-enqueues
 * it: long enough that the Approval's own request has finished handing it off.
 */
const LOST_HAND_OFF_AFTER_MILLISECONDS = 60 * 1000;

/**
 * How long after its deadline a Send still `QUEUED` is resolved by the backstop. No Resend call is
 * made after the deadline, and a delivered message records its outcome right at it; a Send still
 * `QUEUED` an hour later lost its message after the hand-off, for example to retention expiry.
 */
const BACKSTOP_AFTER_DEADLINE_MILLISECONDS = 60 * 60 * 1000;

/**
 * `sending_status = 'QUEUED'` with the value inlined: SQLite uses a partial index only when the
 * query's terms imply the index's `WHERE` as written, and `eq()` would bind the value as a
 * parameter, which implies nothing.
 */
const IS_QUEUED = sql`${drafts.sendingStatus} = 'QUEUED'`;

/**
 * Runs one tick of the Send reconciler: both jobs, one after the other. The backstop runs even when
 * re-enqueueing failed, since it does not touch the Queue.
 */
export async function reconcileSends({
  database,
  sendQueue,
}: SendReconcilerDependencies): Promise<void> {
  await reenqueueLostHandOffs(database, sendQueue);
  await resolveExpiredSends(database);
}

/**
 * Re-enqueues the oldest lost hand-offs with one `sendBatch()` of their frozen Send intents, then
 * records their hand-off. A failed `sendBatch()` ends the job for this tick without recording
 * anything, so a Queues outage is not hammered; later ticks drain the backlog.
 */
async function reenqueueLostHandOffs(
  database: DrizzleD1Database,
  sendQueue: SendQueue,
): Promise<void> {
  const approvedBefore =
    Temporal.Now.instant().epochMilliseconds - LOST_HAND_OFF_AFTER_MILLISECONDS;
  // The conditions and the order match the partial index `drafts_queued_not_enqueued_approved_at_index`.
  const lostHandOffs = await database
    .select()
    .from(drafts)
    .where(and(IS_QUEUED, isNull(drafts.enqueuedAt), lt(drafts.approvedAt, approvedBefore)))
    .orderBy(asc(drafts.approvedAt))
    .limit(ROWS_PER_JOB_AND_TICK);
  if (lostHandOffs.length === 0) {
    return;
  }

  try {
    await sendQueue.sendBatch(
      lostHandOffs.map((draftRow) => ({ body: toSendQueueMessage(draftRow) })),
    );
  } catch (error) {
    console.error(
      `Re-enqueueing ${lostHandOffs.length} lost Send hand-offs failed; the next tick of the Send reconciler tries again. ${findRootCauseMessage(error)}`,
    );
    return;
  }

  // One statement per Draft: D1 binds at most 100 parameters per statement. Each one is conditional
  // like the Approval's own, in case a Send ended in the meantime.
  const enqueuedAt = Temporal.Now.instant().epochMilliseconds;
  const [firstUpdate, ...otherUpdates] = lostHandOffs.map((draftRow) =>
    database
      .update(drafts)
      .set({ enqueuedAt })
      .where(
        and(
          eq(drafts.id, draftRow.id),
          eq(drafts.sendingStatus, "QUEUED"),
          isNull(drafts.enqueuedAt),
        ),
      ),
  );
  if (firstUpdate !== undefined) {
    await database.batch([firstUpdate, ...otherUpdates]);
  }
}

/**
 * Records `FAILED` / `OUTCOME_UNKNOWN` for the Sends whose deadline passed longest ago, among those
 * still `QUEUED` an hour after it. Each write is conditional on `QUEUED`, so a Send that ended in
 * the meantime keeps its outcome, and a late `SENT` still overrides this one.
 */
async function resolveExpiredSends(database: DrizzleD1Database): Promise<void> {
  const deadlineBefore =
    Temporal.Now.instant().epochMilliseconds - BACKSTOP_AFTER_DEADLINE_MILLISECONDS;
  // The conditions and the order match the partial index `drafts_queued_deadline_index`.
  const expiredSends = await database
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(IS_QUEUED, lt(drafts.deadline, deadlineBefore)))
    .orderBy(asc(drafts.deadline))
    .limit(ROWS_PER_JOB_AND_TICK);

  for (const { id } of expiredSends) {
    await recordFailed(database, id, { reason: "OUTCOME_UNKNOWN" });
  }
}
