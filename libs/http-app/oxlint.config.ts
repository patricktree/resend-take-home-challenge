import { defineConfig } from "oxlint";

import { config as repoConfig } from "@resend-challenge/config-oxlint/oxlint-base.js";

export default defineConfig({ extends: [repoConfig] });
