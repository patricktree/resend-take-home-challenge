import * as jsonc from "jsonc-parser";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";

const WRANGLER_CONFIG_URL = new URL(
  "../../../apps/cloudflare-worker/wrangler.jsonc",
  import.meta.url,
);
const README_URL = new URL("../../../README.md", import.meta.url);

// `pnpm secrets:generate` replaces the Agent token wherever README.md shows it, so the two must agree.
test("the README shows the Agent token that wrangler.jsonc configures", async ({ expect }) => {
  const configTree = jsonc.parseTree(await fs.readFile(WRANGLER_CONFIG_URL, "utf8"));
  const agentToken: unknown =
    configTree && jsonc.findNodeAtLocation(configTree, ["vars", "AGENT_TOKEN"])?.value;
  const readme = await fs.readFile(README_URL, "utf8");

  assert(typeof agentToken === "string", "wrangler.jsonc configures no `vars.AGENT_TOKEN`");
  expect(agentToken).toMatch(/^agent_/);
  expect(readme).toContain(`\`${agentToken}\``);
});
