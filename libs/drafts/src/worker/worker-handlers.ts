/*
 * The Worker's `queue` and `scheduled` handlers: they build what the Send pipeline needs from the
 * bindings, each on a fresh D1 session for writes, and call into `send/`.
 */

import { consumeSendBatch } from "../send/send-consumer.ts";
import { consumeSendDlqBatch } from "../send/send-dlq-consumer.ts";
import { reconcileSends } from "../send/send-reconciler.ts";
import { drizzleForSession } from "../storage/database.ts";
import type { SendPipelineEnvironment, SendReconcilerEnvironment } from "./environment.ts";
import { SEND_DLQ_NAME, SEND_QUEUE_NAME } from "./queue-names.ts";

/** Handles a batch from the Send Queue or the Send DLQ, dispatching on `batch.queue`. */
export async function handleQueueBatch(
  batch: MessageBatch,
  env: SendPipelineEnvironment,
): Promise<void> {
  if (batch.queue === SEND_QUEUE_NAME) {
    await consumeSendBatch(batch, {
      database: drizzleForSession(env.DB, "first-primary").database,
      revisionBodies: env.REVISION_BODIES,
      resend: { baseUrl: env.RESEND_BASE_URL, apiKey: env.RESEND_API_KEY },
    });
    return;
  }
  if (batch.queue === SEND_DLQ_NAME) {
    await consumeSendDlqBatch(batch, {
      database: drizzleForSession(env.DB, "first-primary").database,
    });
    return;
  }
  throw new Error(`No consumer handles batches of the queue "${batch.queue}".`);
}

/** Runs one tick of the cron-driven Send reconciler, on a database session for writes. */
export async function runScheduledTasks(env: SendReconcilerEnvironment): Promise<void> {
  const { database } = drizzleForSession(env.DB, "first-primary");
  await reconcileSends({ database, sendQueue: env.SEND_QUEUE });
}
