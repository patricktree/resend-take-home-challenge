import { config as baseConfig } from "@patricktree-stack/config-vitest/vitest-base.js";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { coverage: { thresholds: { branches: 90, functions: 100, lines: 95, statements: 95 } } },
  }),
);
