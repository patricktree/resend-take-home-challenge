import { test } from "vitest";

import { PRODUCTION_API_URL, PUBLIC_AGENT_TOKEN } from "../src/production.ts";
import { readProductionVar } from "./production-config.ts";

// Constant checks against the production config, without any network access.
test("the built-in API URL is the production Worker's PUBLIC_BASE_URL", async ({ expect }) => {
  expect(PRODUCTION_API_URL).toBe(await readProductionVar("PUBLIC_BASE_URL"));
});

// `pnpm secrets:generate` rewrites both, so they only drift apart through a hand edit.
test("the fallback token is the public Agent token the production Worker accepts", async ({
  expect,
}) => {
  expect(PUBLIC_AGENT_TOKEN).toBe(await readProductionVar("AGENT_TOKEN"));
});
