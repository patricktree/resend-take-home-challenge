#!/usr/bin/env node
import util from "node:util";

import { ApiError, ResendChallengeClient } from "@resend-challenge/api.client";
import { LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN } from "@resend-challenge/api.routes";

import { seedDrafts } from "#src/seed.ts";

/** Where `pnpm dev` serves the Worker. */
const DEFAULT_BASE_URL = "http://localhost:5173";

const { values } = util.parseArgs({
  options: { "base-url": { type: "string" } },
});
// The local tokens work only on a local host, so the seed never reaches a deployed Worker.
const baseUrl = values["base-url"] ?? process.env["RESEND_CHALLENGE_BASE_URL"] ?? DEFAULT_BASE_URL;

try {
  console.log(`Seeding Drafts on ${baseUrl}:`);
  await seedDrafts({
    agentClient: new ResendChallengeClient({ baseUrl, token: LOCAL_AGENT_TOKEN }),
    reviewerClient: new ResendChallengeClient({ baseUrl, token: LOCAL_REVIEWER_TOKEN }),
    print: (line) => console.log(line),
  });
} catch (error) {
  const reason =
    error instanceof ApiError
      ? `${error.status} ${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Unknown error.";
  console.error(`Seeding failed (is \`pnpm dev\` running on ${baseUrl}?). ${reason}`);
  process.exitCode = 1;
}
