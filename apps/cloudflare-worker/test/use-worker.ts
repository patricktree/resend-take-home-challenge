import nodeUrl from "node:url";
import type { TestContext } from "vitest";
import { createTestHarness, type WorkerHandle } from "wrangler";

export type TestWorker = WorkerHandle<TestWorkerEnvironment>;

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

type UseWorkerOptions = {
  /** Test-only vars that override wrangler.test.jsonc, for example `LOCAL_DEVELOPMENT`. */
  vars?: Record<string, string>;
  /** Test-only secrets, for example `REVIEWER_TOKEN` (absent by default, as in local development). */
  secrets?: Record<string, string>;
};

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
        vars: { AGENT_TOKEN: TEST_AGENT_TOKEN, ...options.vars },
        secrets: options.secrets ?? {},
      },
    ],
  });
  onTestFinished(() => testRuntime.close());

  await testRuntime.listen();
  const worker = testRuntime.getWorker<TestWorkerEnvironment>();
  await worker.applyD1Migrations("DB");

  return worker;
}
