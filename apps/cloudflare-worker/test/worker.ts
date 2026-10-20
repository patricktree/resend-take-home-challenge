/*
 * The test runtime's entry point (see wrangler.test.jsonc): the production Worker, with two
 * test-only additions that are not part of the production build.
 *
 * - Its Send Queue producer is wrapped in a recording double, so that tests count the Send intents
 *   that requests hand off. Every message still goes to the real Queue binding. Tests read the
 *   recording through `readSentSendQueueMessages()` in use-worker.ts.
 * - `POST /__test/queue` builds a Send Queue `MessageBatch` from the posted messages, runs the real
 *   `queue()` handler on it with the real bindings, and answers with what the handler did to each
 *   message. The local test runtime cannot dispatch a Queue batch, and real Queue delivery cannot
 *   force a duplicate, so every consumer scenario goes through this route
 *   (`deliverSendQueueBatch()` in use-worker.ts).
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { SEND_QUEUE_NAME, type SendQueue, type SendQueueMessage } from "@draft-approval/drafts";

import productionWorker from "#src/index.ts";

/** What the `queue()` handler did to one message; use-worker.ts parses the same shape. */
type MessageHandling = {
  id: string;
  outcome: "ACK" | "RETRY" | "NONE";
  /** The `delaySeconds` of a retry, when the handler passed one. */
  delaySeconds?: number;
};

type TestWorkerEnvironment = Parameters<typeof productionWorker.fetch>[1];

const TEST_QUEUE_PATHNAME = "/__test/queue";

const testQueueRequestSchema = z.strictObject({
  messages: z.array(
    z.strictObject({ id: z.string(), body: z.unknown(), attempts: z.int().positive() }),
  ),
});

/** Each test starts its own Worker, so this module, and with it the recording, is per test. */
const sentSendQueueMessages: SendQueueMessage[] = [];

export default class TestWorker extends WorkerEntrypoint<TestWorkerEnvironment> {
  override async fetch(request: Request<unknown, IncomingRequestCfProperties>): Promise<Response> {
    if (new URL(request.url).pathname === TEST_QUEUE_PATHNAME && request.method === "POST") {
      const { messages } = testQueueRequestSchema.parse(await request.json());
      return Response.json(await this.runQueueHandler(messages));
    }

    const recordingSendQueue: SendQueue = {
      send: async (message) => {
        const response = await this.env.SEND_QUEUE.send(message);
        sentSendQueueMessages.push(message);
        return response;
      },
    };
    return productionWorker.fetch(
      request,
      { ...this.env, SEND_QUEUE: recordingSendQueue },
      this.ctx,
    );
  }

  override queue(batch: MessageBatch): Promise<void> {
    return productionWorker.queue(batch, this.env);
  }

  override scheduled(): Promise<void> {
    return productionWorker.scheduled();
  }

  /** Every message the Worker's requests sent to the Send Queue, in order. */
  sentSendQueueMessages(): SendQueueMessage[] {
    return sentSendQueueMessages;
  }

  private async runQueueHandler(
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
      queue: SEND_QUEUE_NAME,
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
      messages: messages.map(({ id, body, attempts }, index) => ({
        id,
        // The consumer does not read it; fail loudly should that change, rather than make one up.
        get timestamp(): Date {
          throw new Error("POST /__test/queue does not model message timestamps.");
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
