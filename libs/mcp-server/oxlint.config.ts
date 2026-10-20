import { defineConfig } from "oxlint";

import { config as repoConfig } from "@draft-approval/config-oxlint/oxlint-base.js";

export default defineConfig({ extends: [repoConfig] });
