/**
 * Handles a batch from the Send Queue or the Send DLQ, dispatching on `batch.queue`.
 *
 * No consumer is configured yet, so any batch that arrives here is unexpected.
 */
export async function handleQueueBatch(batch: MessageBatch): Promise<void> {
  throw new Error(`No consumer handles batches of the queue "${batch.queue}".`);
}

/** Runs the cron-driven Send reconciler; there is nothing to reconcile yet. */
export async function runScheduledTasks(): Promise<void> {}
