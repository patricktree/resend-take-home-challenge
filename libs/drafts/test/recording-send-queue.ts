import type { SendQueue, SendQueueMessage } from "../src/send-queue.ts";

/** A Send Queue test double that records every message sent to it. */
export type RecordingSendQueue = SendQueue & {
  /** The messages of every `send()`, in order. */
  sentMessages: SendQueueMessage[];
  /** The messages of every `sendBatch()`, one array per call, in order. */
  sentBatches: SendQueueMessage[][];
};

/**
 * Cloudflare Queues' limits of one `sendBatch()`
 * (https://developers.cloudflare.com/queues/platform/limits/): 100 messages and 256 KB in total,
 * with KB read as 1000 bytes, the stricter reading; each message counts its body plus about 100
 * bytes of internal metadata.
 */
const QUEUE_BATCH_LIMITS = {
  MESSAGES: 100,
  BYTES: 256 * 1000,
  METADATA_BYTES_PER_MESSAGE: 100,
} as const;

/**
 * Records every message; a `sendBatch()` over Cloudflare Queues' batch limits throws and records
 * nothing, as the real binding refuses it.
 */
export function createRecordingSendQueue(): RecordingSendQueue {
  const sentMessages: SendQueueMessage[] = [];
  const sentBatches: SendQueueMessage[][] = [];
  return {
    sentMessages,
    sentBatches,
    send: async (message) => {
      sentMessages.push(message);
    },
    sendBatch: async (messageRequests) => {
      const messages = Array.from(messageRequests, ({ body }) => body);
      const batchBytes = messages.reduce(
        (total, message) =>
          total +
          new TextEncoder().encode(JSON.stringify(message)).byteLength +
          QUEUE_BATCH_LIMITS.METADATA_BYTES_PER_MESSAGE,
        0,
      );
      if (messages.length > QUEUE_BATCH_LIMITS.MESSAGES) {
        throw new Error(
          `sendBatch() of ${messages.length} messages exceeds the limit of ${QUEUE_BATCH_LIMITS.MESSAGES}.`,
        );
      }
      if (batchBytes > QUEUE_BATCH_LIMITS.BYTES) {
        throw new Error(
          `sendBatch() of ${batchBytes} bytes exceeds the limit of ${QUEUE_BATCH_LIMITS.BYTES}.`,
        );
      }
      sentBatches.push(messages);
    },
  };
}

/**
 * A Send Queue test double whose every `send()` and `sendBatch()` fails, as during a Queues outage.
 * The error wraps its root cause, which carries `rootCauseMessage`, in an error whose message is
 * `wrapperMessage`.
 */
export function createFailingSendQueue({
  rootCauseMessage,
  wrapperMessage,
}: {
  rootCauseMessage: string;
  wrapperMessage: string;
}): SendQueue {
  const fail = async () => {
    throw new Error(wrapperMessage, { cause: new Error(rootCauseMessage) });
  };
  return { send: fail, sendBatch: fail };
}
