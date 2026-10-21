// @ts-check

import { config as baseConfig } from "@patricktree-stack/config-oxlint/oxlint-base.js";
import { defineConfig } from "oxlint";

/* This repository uses relative imports: drop only the shared config's pattern that forbids them and keep its other restrictions. */
const RELATIVE_IMPORT_GROUP = JSON.stringify(["./**", "../**"]);
const noRestrictedImports = /** @type {unknown[]} */ (
  [baseConfig.rules?.["no-restricted-imports"] ?? "error"].flat()
).map((setting) =>
  setting !== null &&
  typeof setting === "object" &&
  "patterns" in setting &&
  Array.isArray(setting.patterns)
    ? {
        ...setting,
        patterns: setting.patterns.filter(
          (pattern) => JSON.stringify(pattern?.group) !== RELATIVE_IMPORT_GROUP,
        ),
      }
    : setting,
);

export const config = defineConfig({
  extends: [baseConfig],
  options: {
    maxWarnings: 0,
    typeAware: true,
  },
  rules: {
    "no-restricted-imports": [
      ...noRestrictedImports,
      {
        paths: [
          {
            name: "@tanstack/react-query",
            importNames: ["useQuery"],
            message: "Use `useSuspenseQuery` instead.",
          },
        ],
      },
    ],
  },
});
