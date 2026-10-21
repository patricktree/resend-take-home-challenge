import { createBaseConfig } from "@patricktree-stack/config-oxfmt/oxfmt-base.js";
import { defineConfig } from "oxfmt";

const baseConfig = createBaseConfig({
  patricktreeStackGitSubmoduleRelativePath: ".patricktree-stack",
});

export default defineConfig({
  ...baseConfig,
  ignorePatterns: [
    ...baseConfig.ignorePatterns,
    "**/worker-configuration.d.ts",
    /* written by the snapshot test, which compares it byte for byte */
    "apps/cloudflare-worker/test/__snapshots__/openapi.json",
    /* written by `drizzle-kit generate` */
    "libs/drafts/migrations/**",
  ],
  sortImports: {
    customGroups: [
      /* create a group for resend-challenge packages to separate them from other external dependencies */
      {
        groupName: "resend-challenge-packages",
        elementNamePattern: ["@resend-challenge/**"],
      },
    ],
    groups: [
      ["value-builtin", "type-builtin", "value-external", "type-external"],
      ["value-external", "type-external"],
      ["value-internal", "type-internal"],
      "resend-challenge-packages",
      ["value-parent", "type-parent", "value-sibling", "type-sibling", "value-index", "type-index"],
      "unknown",
    ],
  },
});
