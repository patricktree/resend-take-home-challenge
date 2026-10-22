import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

// The unit tests cover pure functions only, so they need none of vite.config.ts's plugins.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      /* Failures must be fixed, never retried away. */
      retry: 0,
    },
  }),
);
