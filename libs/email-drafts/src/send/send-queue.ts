/*
 * The Send Queue port (spec section 9): the producer side an Approval and the Send reconciler send
 * to, and the limits of one `sendBatch()`.
 *
 * The messages' shape and schema live in `domain/send-queue-message.ts`, so
 * `storage/send-outbox.ts` builds messages from rows without importing `send/`, which itself
 * imports `storage/`. This module imports only `domain/`.
 */

import type { SendQueueMessage } from "../domain/send-queue-message.ts";

/**
 * The producer side of the Send Queue: the Approval hands its Send intent to it with `send()`, the
 * Send reconciler re-enqueues lost hand-offs with `sendBatch()`. The `SEND_QUEUE` binding satisfies
 * it; tests pass recording or failing doubles.
 */
export type SendQueue = {
  send(message: SendQueueMessage): Promise<unknown>;
  sendBatch(messages: Iterable<MessageSendRequest<SendQueueMessage>>): Promise<unknown>;
};

/**
 * Cloudflare Queues' limits of one `sendBatch()`
 * (https://developers.cloudflare.com/queues/platform/limits/): 100 messages and 256 KB in total,
 * with KB read as 1000 bytes, the stricter reading. Each message counts its body plus up to about
 * 100 bytes of internal metadata, reserved here. A message of the largest Draft data is about 17
 * KB, so 100 of them need several calls. The recording Send Queue double of the tests
 * (`test/recording-send-queue.ts`) refuses a `sendBatch()` over these same limits.
 */
export const QUEUE_BATCH_LIMITS = {
  MESSAGES: 100,
  BYTES: 256 * 1000,
  METADATA_BYTES_PER_MESSAGE: 100,
} as const;
