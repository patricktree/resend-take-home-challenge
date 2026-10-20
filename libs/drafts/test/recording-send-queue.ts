import type { SendQueue, SendQueueMessage } from "#src/send-queue.ts";

/** A Send Queue test double that records every message sent to it. */
export type RecordingSendQueue = SendQueue & { sentMessages: SendQueueMessage[] };

export function createRecordingSendQueue(): RecordingSendQueue {
  const sentMessages: SendQueueMessage[] = [];
  return {
    sentMessages,
    send: async (message) => {
      sentMessages.push(message);
    },
  };
}

/**
 * A Send Queue test double whose every `send()` fails, as during a Queues outage. The error wraps
 * its root cause, which carries `rootCauseMessage`, in an error whose message is `wrapperMessage`.
 */
export function createFailingSendQueue({
  rootCauseMessage,
  wrapperMessage,
}: {
  rootCauseMessage: string;
  wrapperMessage: string;
}): SendQueue {
  return {
    send: async () => {
      throw new Error(wrapperMessage, { cause: new Error(rootCauseMessage) });
    },
  };
}
