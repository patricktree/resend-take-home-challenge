import { defineConfig } from "rolldown";

/**
 * Bundles the CLI, the workspace libraries it imports and all their npm dependencies into one
 * committed file, so an Agent runs it from a fresh clone with nothing but Node.js 24.
 */
export default defineConfig({
  input: "./src/cli.ts",
  platform: "node",
  /* Only Node.js builtins stay imports; everything else goes into the bundle. */
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
});
