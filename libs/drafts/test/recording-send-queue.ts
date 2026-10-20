import type { SendQueue, SendQueueMessage } from "#src/send-queue.ts";

/** A Send Queue test double that records every message sent to it. */
export type RecordingSendQueue = SendQueue & {
  /** The messages of every `send()`, in order. */
  sentMessages: SendQueueMessage[];
  /** The messages of every `sendBatch()`, one array per call, in order. */
  sentBatches: SendQueueMessage[][];
};

export function createRecordingSendQueue(): RecordingSendQueue {
  const sentMessages: SendQueueMessage[] = [];
  const sentBatches: SendQueueMessage[][] = [];
  return {
    sentMessages,
    sentBatches,
    send: async (message) => {
      sentMessages.push(message);
    },
    sendBatch: async (messages) => {
      sentBatches.push(Array.from(messages, ({ body }) => body));
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
