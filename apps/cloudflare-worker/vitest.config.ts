import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      /* Every test starts its own Worker through `useWorker()`, so the tests of a file can run concurrently. */
      sequence: { concurrent: true },
      /* Failures must be fixed, never retried away. */
      retry: 0,
      /* Starting a Worker in the local test runtime takes a few hundred milliseconds, more under load. */
      testTimeout: 30_000,
    },
  }),
);
