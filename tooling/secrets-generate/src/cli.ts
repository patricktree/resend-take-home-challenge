#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

import { generateSecrets } from "./secrets-generate.ts";

const WORKER_DIRECTORY = url.fileURLToPath(
  new URL("../../../apps/cloudflare-worker", import.meta.url),
);
// The Worker package's own Wrangler, so the secrets land on the Worker its wrangler.jsonc names.
const WRANGLER_EXECUTABLE = path.join(WORKER_DIRECTORY, "node_modules", ".bin", "wrangler");

try {
  await generateSecrets({
    workerDirectory: WORKER_DIRECTORY,
    wranglerExecutable: WRANGLER_EXECUTABLE,
    print: (line) => console.log(line),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Generating the tokens failed.");
  process.exitCode = 1;
}
