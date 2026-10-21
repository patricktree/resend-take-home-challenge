import { drizzleForSession } from "./database.ts";
import { consumeSendBatch, type SendPipelineEnvironment } from "./send-consumer.ts";
import { consumeSendDlqBatch } from "./send-dlq-consumer.ts";
import { SEND_DLQ_NAME, SEND_QUEUE_NAME, type SendQueue } from "./send-queue.ts";
import { reconcileSends } from "./send-reconciler.ts";

/** The Worker bindings the Send reconciler reads. */
export type SendReconcilerEnvironment = {
  DB: D1Database;
  /** The Send Queue's producer binding; the reconciler re-enqueues lost hand-offs to it. */
  SEND_QUEUE: SendQueue;
};

/** Handles a batch from the Send Queue or the Send DLQ, dispatching on `batch.queue`. */
export async function handleQueueBatch(
  batch: MessageBatch,
  env: SendPipelineEnvironment,
): Promise<void> {
  if (batch.queue === SEND_QUEUE_NAME) {
    await consumeSendBatch(batch, env);
    return;
  }
  if (batch.queue === SEND_DLQ_NAME) {
    await consumeSendDlqBatch(batch, env);
    return;
  }
  throw new Error(`No consumer handles batches of the queue "${batch.queue}".`);
}

/** Runs one tick of the cron-driven Send reconciler, on a database session for writes. */
export async function runScheduledTasks(env: SendReconcilerEnvironment): Promise<void> {
  const { database } = drizzleForSession(env.DB, "first-primary");
  await reconcileSends({ database, sendQueue: env.SEND_QUEUE });
}
