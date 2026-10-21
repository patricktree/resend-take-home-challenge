/*
 * The test runtime's entry point (see wrangler.test.jsonc): the production Worker, with two
 * test-only additions that are not part of the production build. Tests reach both through RPC on
 * `worker.getExport()`; `fetch()` only delegates to the production Worker.
 *
 * - Its Send Queue producer is wrapped in a recording double, in requests and in the cron-driven
 *   `scheduled()`, so that tests count the Send intents that the Approval hands off and the Send
 *   reconciler re-enqueues. Every message still goes to the real Queue binding. Tests read the
 *   recording through `readSentSendQueueMessages()` and `readSendQueueCalls()` in use-worker.ts.
 * - The RPC methods `deliverSendQueueBatch()` and `deliverSendDlqBatch()` build a `MessageBatch` of
 *   the Send Queue or of its dead-letter queue from the given messages, run the real `queue()`
 *   handler on it with the real bindings, and return what the handler did to each message. The
 *   local test runtime cannot dispatch a Queue batch, and real Queue delivery cannot force a
 *   duplicate, so every consumer scenario goes through these methods (`deliverSendQueueBatch()`
 *   and `deliverSendDlqBatch()` in use-worker.ts).
 */

import { WorkerEntrypoint } from "cloudflare:workers";

import {
  SEND_DLQ_NAME,
  SEND_QUEUE_NAME,
  type SendQueue,
  type SendQueueMessage,
} from "@resend-challenge/email-drafts";

import productionWorker from "../src/index.ts";

/** What the `queue()` handler did to one message of a delivered batch. */
export type MessageHandling = {
  id: string;
  outcome: "ACK" | "RETRY" | "NONE";
  /** The `delaySeconds` of a retry, when the handler passed one. */
  delaySeconds?: number;
};

/** One message of a batch delivered through `deliverSendQueueBatch()` or `deliverSendDlqBatch()`. */
export type QueueDelivery = {
  /** The Queue's message id. */
  id: string;
  body: unknown;
  /** `message.attempts`: 1 for the first delivery. */
  attempts: number;
};

/**
 * An empty `Blob` that every batch delivery passes along, and that the Worker ignores.
 *
 * Miniflare's proxy behind `worker.getExport()` runs an RPC call synchronously, blocking the test
 * process's event loop with `Atomics.wait()` until the method's promise settles, unless an argument
 * is a `Blob` or a `ReadableStream`. The Resend stub runs in the test process, so a blocking
 * delivery would hang every Resend call of the consumer until its timeout, and concurrent
 * deliveries could not overlap.
 */
export type NonBlockingCallMarker = Blob;

/** One call of the Send Queue producer, as the recording double saw it. */
export type SendQueueCall = { method: "send" | "sendBatch"; messages: SendQueueMessage[] };

type TestWorkerEnvironment = Parameters<typeof productionWorker.fetch>[1];

/** Each test starts its own Worker, so this module, and with it the recording, is per test. */
const sendQueueCalls: SendQueueCall[] = [];

export default class TestWorker extends WorkerEntrypoint<TestWorkerEnvironment> {
  override fetch(
    request: Request<unknown, IncomingRequestCfProperties>,
  ): Response | Promise<Response> {
    return productionWorker.fetch(request, this.recordingEnvironment(), this.ctx);
  }

  override queue(batch: MessageBatch): Promise<void> {
    return productionWorker.queue(batch, this.env);
  }

  override scheduled(controller: ScheduledController): Promise<void> {
    return productionWorker.scheduled(controller, this.recordingEnvironment(), this.ctx);
  }

  /** Every call of the Send Queue producer, in order. */
  sendQueueCalls(): SendQueueCall[] {
    return sendQueueCalls;
  }

  /**
   * Runs the real `queue()` handler on one batch of the Send Queue made of `messages`; returns what
   * the handler did to each message, in order. See {@link NonBlockingCallMarker} for the marker.
   */
  deliverSendQueueBatch(
    messages: QueueDelivery[],
    _marker: NonBlockingCallMarker,
  ): Promise<MessageHandling[]> {
    return this.runQueueHandler(SEND_QUEUE_NAME, messages);
  }

  /**
   * Runs the real `queue()` handler on one batch of the Send Queue's dead-letter queue made of
   * `messages`; returns what the handler did to each message, in order. See
   * {@link NonBlockingCallMarker} for the marker.
   */
  deliverSendDlqBatch(
    messages: QueueDelivery[],
    _marker: NonBlockingCallMarker,
  ): Promise<MessageHandling[]> {
    return this.runQueueHandler(SEND_DLQ_NAME, messages);
  }

  /** The Worker's environment, with its Send Queue producer wrapped in the recording double. */
  private recordingEnvironment(): TestWorkerEnvironment {
    const recordingSendQueue: SendQueue = {
      send: async (message) => {
        const response = await this.env.SEND_QUEUE.send(message);
        sendQueueCalls.push({ method: "send", messages: [message] });
        return response;
      },
      sendBatch: async (messageRequests) => {
        const requests = [...messageRequests];
        const response = await this.env.SEND_QUEUE.sendBatch(requests);
        sendQueueCalls.push({ method: "sendBatch", messages: requests.map(({ body }) => body) });
        return response;
      },
    };
    return { ...this.env, SEND_QUEUE: recordingSendQueue };
  }

  private async runQueueHandler(
    queueName: string,
    messages: QueueDelivery[],
  ): Promise<MessageHandling[]> {
    const handlings = messages.map(({ id }): MessageHandling => ({ id, outcome: "NONE" }));
    const settle = (index: number, handling: Omit<MessageHandling, "id">) => {
      const current = handlings[index];
      if (current === undefined || current.outcome !== "NONE") {
        throw new Error(`The queue() handler settled message ${index} more than once.`);
      }
      handlings[index] = { id: current.id, ...handling };
    };
    const retry = (index: number, options?: QueueRetryOptions) => {
      settle(index, {
        outcome: "RETRY",
        ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
      });
    };

    const batch: MessageBatch = {
      queue: queueName,
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
      messages: messages.map(({ id, body, attempts }, index) => ({
        id,
        // The consumer does not read it; fail loudly should that change, rather than make one up.
        get timestamp(): Date {
          throw new Error("The test entry point's batches do not model message timestamps.");
        },
        body,
        attempts,
        ack: () => {
          settle(index, { outcome: "ACK" });
        },
        retry: (options) => {
          retry(index, options);
        },
      })),
      ackAll: () => {
        for (const index of messages.keys()) {
          settle(index, { outcome: "ACK" });
        }
      },
      retryAll: (options) => {
        for (const index of messages.keys()) {
          retry(index, options);
        }
      },
    };

    await productionWorker.queue(batch, this.env);
    return handlings;
  }
}
