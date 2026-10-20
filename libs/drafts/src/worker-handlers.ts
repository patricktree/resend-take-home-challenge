import { consumeSendBatch, type SendPipelineEnvironment } from "#src/send-consumer.ts";
import { SEND_DLQ_NAME, SEND_QUEUE_NAME } from "#src/send-queue.ts";

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
    // A placeholder until the DLQ consumer, which records `FAILED` / `OUTCOME_UNKNOWN`, exists; the
    // Send reconciler's backstop would resolve these Sends anyway.
    batch.ackAll();
    return;
  }
  throw new Error(`No consumer handles batches of the queue "${batch.queue}".`);
}

/** Runs the cron-driven Send reconciler; there is nothing to reconcile yet. */
export async function runScheduledTasks(): Promise<void> {}
