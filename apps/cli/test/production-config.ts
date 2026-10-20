import * as jsonc from "jsonc-parser";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const WRANGLER_CONFIG_URL = new URL("../../cloudflare-worker/wrangler.jsonc", import.meta.url);

/** A var of the production Worker's `wrangler.jsonc`, the source of truth for the CLI's defaults. */
export async function readProductionVar(name: string): Promise<string> {
  const configTree = jsonc.parseTree(await fs.readFile(WRANGLER_CONFIG_URL, "utf8"));
  const value: unknown = configTree && jsonc.findNodeAtLocation(configTree, ["vars", name])?.value;
  assert(typeof value === "string", `wrangler.jsonc configures no \`vars.${name}\``);
  return value;
}
