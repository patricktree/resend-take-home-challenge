import nodeUrl from "node:url";
import type { TestContext } from "vitest";
import { createTestHarness } from "wrangler";

/** The bindings the Draft use cases run on, reached from Node through the test runtime. */
export type TestBindings = {
  DB: D1Database;
  REVISION_BODIES: R2Bucket;
};

const PACKAGE_DIRECTORY = nodeUrl.fileURLToPath(new URL("..", import.meta.url));

/**
 * Starts a fresh instance of the test Worker in Wrangler's local test runtime, with the D1
 * migrations applied and empty D1 and R2 storage, returns its bindings and closes it when the test
 * finishes.
 *
 * Pass `onTestFinished` from the test's own context: Vitest tracks hooks per test only through the
 * context, which keeps concurrent tests in one file apart.
 */
export async function useBindings({
  onTestFinished,
}: Pick<TestContext, "onTestFinished">): Promise<TestBindings> {
  const testRuntime = createTestHarness({
    root: PACKAGE_DIRECTORY,
    workers: [{ configPath: "./test/wrangler.test.jsonc" }],
  });
  onTestFinished(() => testRuntime.close());

  await testRuntime.listen();
  const worker = testRuntime.getWorker<TestBindings>();
  await worker.applyD1Migrations("DB");

  return worker.getEnv();
}
