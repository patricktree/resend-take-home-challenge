import { defineConfig } from "oxlint";

import { config as repoConfig } from "@resend-challenge/config-oxlint/oxlint-base.js";

export default defineConfig({
  extends: [repoConfig],
  rules: {
    /* replaces the repository's rule, so it repeats its `Date` entry */
    "no-restricted-globals": [
      "error",
      {
        name: "Date",
        message: "Use `Temporal` via polyfill `temporal-polyfill` instead.",
      },
      {
        name: "fetch",
        message:
          "Call the API through `ApiClient` (#src/api-client.ts), which sends the stored Reviewer token.",
      },
    ],
  },
});
