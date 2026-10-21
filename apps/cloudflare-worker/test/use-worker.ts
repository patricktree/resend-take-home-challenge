import nodeUrl from "node:url";
import type { TestContext } from "vitest";
import { createTestHarness, type WorkerHandle } from "wrangler";
import { z } from "zod";

import type { SendQueueMessage } from "@resend-challenge/drafts";

import type * as testWorkerModule from "./worker.ts";
import type { SendQueueCall } from "./worker.ts";

export type TestWorker = WorkerHandle<TestWorkerEnvironment, typeof testWorkerModule>;

/** The configured Agent token (`AGENT_TOKEN`) of every test Worker. */
export const TEST_AGENT_TOKEN = "agent_test-configured-agent-token";

/** A Reviewer token for tests that configure `REVIEWER_TOKEN` through `secrets`. */
export const TEST_REVIEWER_TOKEN = "reviewer_test-configured-reviewer-token";

const PACKAGE_DIRECTORY = nodeUrl.fileURLToPath(new URL("..", import.meta.url));

type TestWorkerEnvironment = {
  DB: D1Database;
  REVISION_BODIES: R2Bucket;
  SEND_QUEUE: Queue;
};

/**
 * What the consumer did to one message of a batch from `deliverSendQueueBatch()` or
 * `deliverSendDlqBatch()`.
 */
type MessageHandling = z.infer<typeof messageHandlingsSchema>[number];

/** One message of a batch delivered through `deliverSendQueueBatch()` or `deliverSendDlqBatch()`. */
type DeliveredMessage = {
  body: unknown;
  /** `message.attempts`: 1 for the first delivery, the default. */
  attempts?: number;
  /** The Queue's message id; one per message of the batch by default. */
  id?: string;
};

type UseWorkerOptions = {
  /** Test-only vars that override wrangler.test.jsonc, for example `LOCAL_DEVELOPMENT`. */
  vars?: Record<string, string>;
  /** Test-only secrets, for example `REVIEWER_TOKEN` (absent by default, as in local development). */
  secrets?: Record<string, string>;
  /**
   * Consumes the Send Queue for real, as Miniflare delivers it (the `send-queue-delivery`
   * environment of wrangler.test.jsonc). Off by default: consumer scenarios deliver their batches
   * through `deliverSendQueueBatch()`, which a real consumer would race.
   */
  shouldConsumeSendQueue?: boolean;
};

/** The answer of `POST /__test/queue` and `POST /__test/dlq` (test/worker.ts). */
const messageHandlingsSchema = z.array(
  z.strictObject({
    id: z.string(),
    outcome: z.enum(["ACK", "RETRY", "NONE"]),
    delaySeconds: z.number().optional(),
  }),
);

/**
 * Starts a fresh instance of the whole Worker in Wrangler's local test runtime, with the D1
 * migrations applied and empty D1, R2 and Queue storage, and closes it when the test finishes.
 *
 * Pass `onTestFinished` from the test's own context: Vitest tracks hooks per test only through the
 * context, which keeps concurrent tests in one file apart.
 */
export async function useWorker(
  { onTestFinished }: Pick<TestContext, "onTestFinished">,
  options: UseWorkerOptions = {},
): Promise<TestWorker> {
  const testRuntime = createTestHarness({
    root: PACKAGE_DIRECTORY,
    workers: [
      {
        configPath: "./test/wrangler.test.jsonc",
        ...(options.shouldConsumeSendQueue === true ? { env: "send-queue-delivery" } : {}),
        vars: { AGENT_TOKEN: TEST_AGENT_TOKEN, ...options.vars },
        secrets: options.secrets ?? {},
      },
    ],
  });
  onTestFinished(() => testRuntime.close());

  await testRuntime.listen();
  const worker = testRuntime.getWorker<TestWorkerEnvironment, typeof testWorkerModule>();
  await worker.applyD1Migrations("DB");

  return worker;
}

/**
 * Reads every message the Worker sent to the Send Queue, by `send()` or `sendBatch()`, in order,
 * from the recording double that test/worker.ts wraps around the `SEND_QUEUE` binding.
 */
export async function readSentSendQueueMessages(worker: TestWorker): Promise<SendQueueMessage[]> {
  return (await readSendQueueCalls(worker)).flatMap(({ messages }) => messages);
}

/** Reads every call of the Send Queue producer, in order, from the same recording double. */
export async function readSendQueueCalls(worker: TestWorker): Promise<SendQueueCall[]> {
  const testWorkerExport = await worker.getExport();
  return testWorkerExport.sendQueueCalls();
}

/**
 * Delivers one batch to the Send Queue consumer through the test-only route `POST /__test/queue` of
 * test/worker.ts, which runs the real `queue()` handler with the real bindings, and returns what
 * the handler did to each message, in order.
 */
export function deliverSendQueueBatch(
  worker: TestWorker,
  messages: DeliveredMessage[],
): Promise<MessageHandling[]> {
  return deliverBatch(worker, "/__test/queue", messages);
}

/**
 * Delivers one batch to the DLQ consumer, as the Send Queue's dead-letter queue would, through the
 * test-only route `POST /__test/dlq` of test/worker.ts; returns what the handler did to each
 * message, in order.
 */
export function deliverSendDlqBatch(
  worker: TestWorker,
  messages: DeliveredMessage[],
): Promise<MessageHandling[]> {
  return deliverBatch(worker, "/__test/dlq", messages);
}

/**
 * Runs one tick of the cron trigger through `worker.scheduled()`, as Cloudflare would every minute,
 * on the `scheduled()` of test/worker.ts with its recording Send Queue double; throws unless the
 * handler finished without an exception.
 */
export async function runCronTick(worker: TestWorker): Promise<void> {
  const result = await worker.scheduled({ cron: "* * * * *" });
  if (result.outcome !== "ok") {
    throw new Error(`The scheduled() handler ended with the outcome "${result.outcome}".`);
  }
}

async function deliverBatch(
  worker: TestWorker,
  pathname: "/__test/queue" | "/__test/dlq",
  messages: DeliveredMessage[],
): Promise<MessageHandling[]> {
  const response = await worker.fetch(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messages.map(({ body, attempts = 1, id }, index) => ({
        id: id ?? `message-${index}`,
        body,
        attempts,
      })),
    }),
  });
  if (response.status !== 200) {
    throw new Error(`POST ${pathname} answered with ${response.status}: ${await response.text()}`);
  }
  return messageHandlingsSchema.parse(await response.json());
}
