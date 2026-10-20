import type { KnipConfig } from "knip";

const config: KnipConfig = {
  $schema: "./node_modules/knip/schema.json",
  ignore: [
    /* ignore the patricktree-stack packages themselves, since they are not part of this monorepo */
    ".patricktree-stack/**",
  ],
  workspaces: {
    ".": {
      ignoreDependencies: [
        /* peer dependencies of the WebAssembly bindings of oxc-resolver (used by Knip), which strict peer resolution requires at the root */
        "@emnapi/core",
        "@emnapi/runtime",
      ],
    },
    "apps/cloudflare-worker": {
      /* Wrangler loads the test runtime's Worker entry point from test/wrangler.test.jsonc. */
      entry: ["test/worker.ts"],
      /* `cloudflare:workers` is a module built into the Workers runtime, not a package; Knip reads its scheme as the package name `cloudflare`. */
      ignoreDependencies: ["cloudflare"],
    },
    "libs/drafts": {
      /* Wrangler loads the drafts suite's test Worker entry point from test/wrangler.test.jsonc. */
      entry: ["test/worker.ts"],
    },
  },
};

export default config;
