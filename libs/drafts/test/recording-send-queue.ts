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

/** A Send Queue test double whose every `send()` fails, as during a Queues outage. */
export function createFailingSendQueue(errorMessage: string): SendQueue {
  return {
    send: async () => {
      throw new Error(errorMessage);
    },
  };
}
