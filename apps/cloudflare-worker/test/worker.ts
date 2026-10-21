/*
 * The test runtime's entry point (see wrangler.test.jsonc): the production Worker, with two
 * test-only additions that are not part of the production build.
 *
 * - Its Send Queue producer is wrapped in a recording double, in requests and in the cron-driven
 *   `scheduled()`, so that tests count the Send intents that the Approval hands off and the Send
 *   reconciler re-enqueues. Every message still goes to the real Queue binding. Tests read the
 *   recording through `readSentSendQueueMessages()` and `readSendQueueCalls()` in use-worker.ts.
 * - `POST /__test/queue` and `POST /__test/dlq` build a `MessageBatch` of the Send Queue or of its
 *   dead-letter queue from the posted messages, run the real `queue()` handler on it with the real
 *   bindings, and answer with what the handler did to each message. The local test runtime cannot
 *   dispatch a Queue batch, and real Queue delivery cannot force a duplicate, so every consumer
 *   scenario goes through these routes (`deliverSendQueueBatch()` and `deliverSendDlqBatch()` in
 *   use-worker.ts).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import {
  SEND_DLQ_NAME,
  SEND_QUEUE_NAME,
  type SendQueue,
  type SendQueueMessage,
} from "@resend-challenge/email-drafts";

import productionWorker from "../src/index.ts";

/** What the `queue()` handler did to one message; use-worker.ts parses the same shape. */
type MessageHandling = {
  id: string;
  outcome: "ACK" | "RETRY" | "NONE";
  /** The `delaySeconds` of a retry, when the handler passed one. */
  delaySeconds?: number;
};

/** One call of the Send Queue producer, as the recording double saw it. */
export type SendQueueCall = { method: "send" | "sendBatch"; messages: SendQueueMessage[] };

type TestWorkerEnvironment = Parameters<typeof productionWorker.fetch>[1];

/** The test-only routes that deliver a batch, and the queue each batch comes from. */
const TEST_QUEUE_ROUTES = new Map([
  ["/__test/queue", SEND_QUEUE_NAME],
  ["/__test/dlq", SEND_DLQ_NAME],
]);

const testQueueRequestSchema = z.strictObject({
  messages: z.array(
    z.strictObject({ id: z.string(), body: z.unknown(), attempts: z.int().positive() }),
  ),
});

/** Each test starts its own Worker, so this module, and with it the recording, is per test. */
const sendQueueCalls: SendQueueCall[] = [];

export default class TestWorker extends WorkerEntrypoint<TestWorkerEnvironment> {
  override async fetch(request: Request<unknown, IncomingRequestCfProperties>): Promise<Response> {
    const testQueueName = TEST_QUEUE_ROUTES.get(new URL(request.url).pathname);
    if (testQueueName !== undefined && request.method === "POST") {
      const { messages } = testQueueRequestSchema.parse(await request.json());
      return Response.json(await this.runQueueHandler(testQueueName, messages));
    }

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
    messages: z.infer<typeof testQueueRequestSchema>["messages"],
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
          throw new Error("The test-only queue routes do not model message timestamps.");
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
