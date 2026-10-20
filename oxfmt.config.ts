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
  ],
  sortImports: {
    customGroups: [
      /* create a group for draft-approval packages to separate them from other external dependencies */
      {
        groupName: "draft-approval-packages",
        elementNamePattern: ["@draft-approval/**"],
      },
      /* create a group for subpath imports = internal dependencies */
      {
        groupName: "subpath-imports",
        elementNamePattern: ["#src/**"],
      },
      /* create a group for subpath imports for test modules */
      {
        groupName: "subpath-imports-test-modules",
        elementNamePattern: ["#test/**"],
      },
      /* create a group for subpath imports for E2E test modules */
      {
        groupName: "subpath-imports-test-modules-e2e",
        elementNamePattern: ["#test-e2e/**"],
      },
    ],
    groups: [
      ["value-builtin", "type-builtin", "value-external", "type-external"],
      ["value-external", "type-external"],
      ["value-internal", "type-internal"],
      "draft-approval-packages",
      "subpath-imports",
      "subpath-imports-test-modules",
      "subpath-imports-test-modules-e2e",
      ["value-parent", "type-parent", "value-sibling", "type-sibling", "value-index", "type-index"],
      "unknown",
    ],
  },
});
