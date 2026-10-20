/*
 * The test runtime's entry point (see wrangler.test.jsonc): the production Worker, with its Send
 * Queue producer wrapped in a recording double, so that tests count the Send intents that requests
 * hand off. Every message still goes to the real Queue binding. Tests read the recording through
 * `readSentSendQueueMessages()` in use-worker.ts.
 */

import { WorkerEntrypoint } from "cloudflare:workers";

import type { SendQueue, SendQueueMessage } from "@draft-approval/drafts";

import productionWorker from "#src/index.ts";

type TestWorkerEnvironment = Parameters<typeof productionWorker.fetch>[1];

/** Each test starts its own Worker, so this module, and with it the recording, is per test. */
const sentSendQueueMessages: SendQueueMessage[] = [];

export default class TestWorker extends WorkerEntrypoint<TestWorkerEnvironment> {
  override fetch(request: Request<unknown, IncomingRequestCfProperties>): Promise<Response> {
    const recordingSendQueue: SendQueue = {
      send: async (message) => {
        const response = await this.env.SEND_QUEUE.send(message);
        sentSendQueueMessages.push(message);
        return response;
      },
    };
    return Promise.resolve(
      productionWorker.fetch(request, { ...this.env, SEND_QUEUE: recordingSendQueue }, this.ctx),
    );
  }

  override queue(batch: MessageBatch): Promise<void> {
    return productionWorker.queue(batch);
  }

  override scheduled(): Promise<void> {
    return productionWorker.scheduled();
  }

  /** Every message the Worker's requests sent to the Send Queue, in order. */
  sentSendQueueMessages(): SendQueueMessage[] {
    return sentSendQueueMessages;
  }
}
