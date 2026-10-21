import type { SendQueue, SendQueueMessage } from "#src/send-queue.ts";

/** A Send Queue test double that records every message sent to it. */
export type RecordingSendQueue = SendQueue & {
  /** The messages of every `send()`, in order. */
  sentMessages: SendQueueMessage[];
  /** The messages of every `sendBatch()`, one array per call, in order. */
  sentBatches: SendQueueMessage[][];
};

/**
 * Cloudflare Queues' limits of one `sendBatch()`
 * (https://developers.cloudflare.com/queues/platform/limits/): 100 messages and 256 KB of message
 * bodies in total, with KB read as 1000 bytes, the stricter reading.
 */
const QUEUE_BATCH_LIMITS = { MESSAGES: 100, BODY_BYTES: 256 * 1000 } as const;

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
      const bodyBytes = messages.reduce(
        (total, message) => total + new TextEncoder().encode(JSON.stringify(message)).byteLength,
        0,
      );
      if (messages.length > QUEUE_BATCH_LIMITS.MESSAGES) {
        throw new Error(`sendBatch() of ${messages.length} messages exceeds the limit of 100.`);
      }
      if (bodyBytes > QUEUE_BATCH_LIMITS.BODY_BYTES) {
        throw new Error(`sendBatch() of ${bodyBytes} bytes exceeds the limit of 256 KB.`);
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
