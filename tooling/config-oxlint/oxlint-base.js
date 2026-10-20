// @ts-check

import { config as baseConfig } from "@patricktree-stack/config-oxlint/oxlint-base.js";
import { defineConfig } from "oxlint";

const noRestrictedImports = baseConfig.rules?.["no-restricted-imports"];

export const config = defineConfig({
  extends: [baseConfig],
  rules: {
    "no-restricted-imports": [
      ...(noRestrictedImports ?? ["error"]),
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
