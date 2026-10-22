import fs from "node:fs/promises";
import { defineConfig } from "rolldown";

/**
 * Bundles the CLI, the workspace libraries it imports and all their npm dependencies into one
 * committed file, so an Agent runs it from a fresh clone with nothing but Node 24.
 */
export default defineConfig({
  input: "./src/cli.ts",
  platform: "node",
  /* Only Node builtins stay imports; everything else goes into the bundle. */
  external: /^node:/,
  transform: { target: "node24" },
  output: {
    file: "./bundle/resend-challenge.mjs",
    format: "esm",
    /* One file: the bundle must not load chunks of its own. */
    codeSplitting: false,
    minify: false,
    sourcemap: false,
    /* Keep the license comments of the bundled packages. */
    comments: { legal: true },
  },
  plugins: [
    {
      /* The bundle starts with `#!/usr/bin/env node`, so it runs as `./resend-challenge.mjs` too. */
      name: "make-executable",
      async writeBundle(outputOptions) {
        if (outputOptions.file !== undefined) {
          await fs.chmod(outputOptions.file, 0o755);
        }
      },
    },
  ],
});
