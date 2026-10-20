import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      /* Every test spawns its own CLI process against its own API stub, so the tests of a file can run concurrently. */
      sequence: { concurrent: true },
      /* Failures must be fixed, never retried away. */
      retry: 0,
      /* Each test starts at least one Node.js process, which takes a few hundred milliseconds, more under load. */
      testTimeout: 30_000,
    },
  }),
);
