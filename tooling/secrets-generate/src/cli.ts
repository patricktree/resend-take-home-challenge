#!/usr/bin/env node
import url from "node:url";

import { generateSecrets } from "./secrets-generate.ts";

const REPOSITORY_ROOT = url.fileURLToPath(new URL("../../..", import.meta.url));
// The Worker package's own Wrangler, so the secret lands on the Worker its wrangler.jsonc names.
const WRANGLER_EXECUTABLE = url.fileURLToPath(
  new URL("../../../apps/cloudflare-worker/node_modules/.bin/wrangler", import.meta.url),
);

try {
  await generateSecrets({
    repositoryRoot: REPOSITORY_ROOT,
    wranglerExecutable: WRANGLER_EXECUTABLE,
    print: (line) => console.log(line),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Generating the tokens failed.");
  process.exitCode = 1;
}
