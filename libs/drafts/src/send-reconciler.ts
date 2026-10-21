/*
 * The Send reconciler (spec section 9, "Send reconciler"): the cron trigger runs it every minute so
 * that no Send stays `QUEUED` forever. Each tick runs two bounded jobs, each on at most 100 rows,
 * oldest first, along its partial index of `drafts`:
 *
 * 1. Lost hand-off: re-enqueues the Sends whose Queue message was never recorded as sent, in as
 *    many `sendBatch()` calls as the Queues batch limits require.
 * 2. Backstop: resolves the Sends still `QUEUED` an hour after their deadline.
 *
 * Duplicates (a request that died between `send()` and setting `enqueued_at`, overlapping ticks)
 * are absorbed by the idempotency key, under which every attempt sends the same frozen body.
 */

import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import assert from "node:assert/strict";
import { Temporal } from "temporal-polyfill";

import { findRootCauseMessage } from "./root-cause.ts";
import { drafts } from "./schema.ts";
import { recordFailed } from "./send-outcomes.ts";
import {
  QUEUE_BATCH_LIMITS,
  toSendQueueMessage,
  type SendQueue,
  type SendQueueMessage,
} from "./send-queue.ts";

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
 * Re-enqueues the oldest lost hand-offs: their frozen Send intents go out in chunks that each fit
 * one `sendBatch()`, oldest first, and each chunk's hand-off is recorded once its `sendBatch()`
 * succeeded. A failed `sendBatch()` ends the job for this tick, so a Queues outage is not hammered;
 * its chunk and the later ones stay unrecorded, and later ticks drain the backlog.
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

  const chunks = chunkWithinQueueBatchLimits(lostHandOffs.map(toSendQueueMessage));
  for (const [index, chunk] of chunks.entries()) {
    try {
      // `json`, so that the size the limit counts is the size `measureBodyBytes()` measured.
      await sendQueue.sendBatch(chunk.map((message) => ({ body: message, contentType: "json" })));
    } catch (error) {
      const unrecordedCount = chunks.slice(index).reduce((total, { length }) => total + length, 0);
      console.error(
        `Re-enqueueing ${unrecordedCount} of ${lostHandOffs.length} lost Send hand-offs failed; the next tick of the Send reconciler tries again. ${findRootCauseMessage(error)}`,
      );
      return;
    }

    await recordHandOffs(database, chunk);
  }
}

/**
 * Records the hand-off of re-enqueued Sends. One statement per Draft: D1 binds at most 100
 * parameters per statement. Each one is conditional like the Approval's own, in case a Send ended
 * in the meantime.
 */
async function recordHandOffs(
  database: DrizzleD1Database,
  messages: SendQueueMessage[],
): Promise<void> {
  const enqueuedAt = Temporal.Now.instant().epochMilliseconds;
  const [firstUpdate, ...otherUpdates] = messages.map(({ draftId }) =>
    database
      .update(drafts)
      .set({ enqueuedAt })
      .where(
        and(eq(drafts.id, draftId), eq(drafts.sendingStatus, "QUEUED"), isNull(drafts.enqueuedAt)),
      ),
  );
  assert(firstUpdate !== undefined, "A re-enqueued chunk has at least one Send.");
  await database.batch([firstUpdate, ...otherUpdates]);
}

/**
 * Splits messages, in order, into consecutive chunks that each stay within the Queues batch limits.
 * A single message is far below them, since spec section 6 ("Limits and request format") bounds the
 * Draft data.
 */
function chunkWithinQueueBatchLimits(messages: SendQueueMessage[]): SendQueueMessage[][] {
  const chunks: SendQueueMessage[][] = [];
  let chunk: SendQueueMessage[] = [];
  let chunkBytes = 0;
  for (const message of messages) {
    const messageBytes = measureBodyBytes(message) + QUEUE_BATCH_LIMITS.METADATA_BYTES_PER_MESSAGE;
    const isChunkFull =
      chunk.length === QUEUE_BATCH_LIMITS.MESSAGES ||
      chunkBytes + messageBytes > QUEUE_BATCH_LIMITS.BYTES;
    if (chunk.length > 0 && isChunkFull) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(message);
    chunkBytes += messageBytes;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

/** The size of a message's body as the Queue receives it with `contentType: "json"`. */
function measureBodyBytes(message: SendQueueMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
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
