import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      /* The live Resend contract test in test-live/ runs only through `pnpm test:resend-live`. */
      include: ["test/**/*.test.ts"],
      /* Every test starts its own stub, so the tests of a file can run concurrently. */
      sequence: { concurrent: true },
      /* Failures must be fixed, never retried away. */
      retry: 0,
    },
  }),
);
