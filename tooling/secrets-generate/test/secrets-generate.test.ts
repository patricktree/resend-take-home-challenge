import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";

import { generateSecrets } from "../src/secrets-generate.ts";

const AGENT_TOKEN_PATTERN = /^agent_[\w-]{43}$/;
const REVIEWER_TOKEN_PATTERN = /^reviewer_[\w-]{43}$/;

const WRANGLER_CONFIG = `// The production config.
{
  "name": "resend-challenge",
  "secrets": {
    "required": ["AGENT_TOKEN", "REVIEWER_TOKEN"],
  },
}
`;

/** Records its arguments, working directory and stdin, like a `wrangler` that only listens. */
const RECORDING_WRANGLER = `#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(new URL("./cwd.txt", import.meta.url), process.cwd());
fs.writeFileSync(new URL("./stdin.txt", import.meta.url), fs.readFileSync(0, "utf8"));
`;

const FAILING_WRANGLER = `#!/usr/bin/env node
import fs from "node:fs";

fs.readFileSync(0, "utf8");
process.exitCode = 1;
`;

test("pipes a new Agent token and a new Reviewer token into one `wrangler secret bulk` over stdin, never as arguments", async ({
  expect,
}) => {
  const workerSetup = await createWorkerSetup(RECORDING_WRANGLER);

  await generateSecrets({
    workerDirectory: workerSetup.workerDirectory,
    wranglerExecutable: workerSetup.wranglerExecutable,
    print: () => {},
  });

  const argv: unknown = JSON.parse(await fs.readFile(workerSetup.wranglerArgvPath, "utf8"));
  expect(argv).toStrictEqual(["secret", "bulk"]);
  const secrets = await readPipedSecrets(workerSetup);
  expect(secrets.AGENT_TOKEN).toMatch(AGENT_TOKEN_PATTERN);
  expect(secrets.REVIEWER_TOKEN).toMatch(REVIEWER_TOKEN_PATTERN);
  expect(await fs.realpath(await fs.readFile(workerSetup.wranglerCwdPath, "utf8"))).toBe(
    await fs.realpath(workerSetup.workerDirectory),
  );
});

test("prints both tokens exactly once, after a warning that they are not shown again", async ({
  expect,
}) => {
  const workerSetup = await createWorkerSetup(RECORDING_WRANGLER);
  const printed: string[] = [];

  await generateSecrets({
    workerDirectory: workerSetup.workerDirectory,
    wranglerExecutable: workerSetup.wranglerExecutable,
    print: (line) => printed.push(line),
  });

  const secrets = await readPipedSecrets(workerSetup);
  const output = printed.join("\n");
  expect(output.split(secrets.AGENT_TOKEN)).toHaveLength(2);
  expect(output.split(secrets.REVIEWER_TOKEN)).toHaveLength(2);
  const warningIndex = output.indexOf("they are not shown again");
  expect(warningIndex).toBeGreaterThan(-1);
  expect(warningIndex).toBeLessThan(output.indexOf(secrets.AGENT_TOKEN));
  expect(warningIndex).toBeLessThan(output.indexOf(secrets.REVIEWER_TOKEN));
});

test("changes no file", async ({ expect }) => {
  const workerSetup = await createWorkerSetup(RECORDING_WRANGLER);

  await generateSecrets({
    workerDirectory: workerSetup.workerDirectory,
    wranglerExecutable: workerSetup.wranglerExecutable,
    print: () => {},
  });

  expect(await fs.readdir(workerSetup.workerDirectory)).toStrictEqual(["wrangler.jsonc"]);
  expect(await fs.readFile(workerSetup.wranglerConfigPath, "utf8")).toBe(WRANGLER_CONFIG);
});

test("fails without printing a token when `wrangler secret bulk` fails", async ({ expect }) => {
  const workerSetup = await createWorkerSetup(FAILING_WRANGLER);
  const printed: string[] = [];

  const run = generateSecrets({
    workerDirectory: workerSetup.workerDirectory,
    wranglerExecutable: workerSetup.wranglerExecutable,
    print: (line) => printed.push(line),
  });

  await expect(run).rejects.toThrow("`wrangler secret bulk` exited with code 1.");
  expect(printed.join("\n")).not.toMatch(/agent_|reviewer_/);
});

/** Reads the JSON object of secret names and values that `wrangler secret bulk` got on stdin. */
async function readPipedSecrets(
  workerSetup: WorkerSetup,
): Promise<{ AGENT_TOKEN: string; REVIEWER_TOKEN: string }> {
  const secrets: unknown = JSON.parse(await fs.readFile(workerSetup.wranglerStdinPath, "utf8"));
  assert(typeof secrets === "object" && secrets !== null, "stdin holds no JSON object");
  assert.deepEqual(Object.keys(secrets).toSorted(), ["AGENT_TOKEN", "REVIEWER_TOKEN"]);
  assert("AGENT_TOKEN" in secrets && "REVIEWER_TOKEN" in secrets);
  const { AGENT_TOKEN: agentToken, REVIEWER_TOKEN: reviewerToken } = secrets;
  assert(typeof agentToken === "string" && typeof reviewerToken === "string");
  return { AGENT_TOKEN: agentToken, REVIEWER_TOKEN: reviewerToken };
}

type WorkerSetup = Awaited<ReturnType<typeof createWorkerSetup>>;

/** A temporary Worker directory with its `wrangler.jsonc`, and a fake `wrangler` next to it. */
async function createWorkerSetup(wranglerScript: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secrets-generate-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));

  const workerDirectory = path.join(root, "cloudflare-worker");
  const wranglerConfigPath = path.join(workerDirectory, "wrangler.jsonc");
  const fakeWranglerDirectory = path.join(root, "fake-wrangler");
  const wranglerExecutable = path.join(fakeWranglerDirectory, "wrangler.mjs");

  await fs.mkdir(workerDirectory);
  await fs.mkdir(fakeWranglerDirectory);
  await fs.writeFile(wranglerConfigPath, WRANGLER_CONFIG);
  await fs.writeFile(wranglerExecutable, wranglerScript, { mode: 0o755 });

  return {
    workerDirectory,
    wranglerConfigPath,
    wranglerExecutable,
    wranglerArgvPath: path.join(fakeWranglerDirectory, "argv.json"),
    wranglerCwdPath: path.join(fakeWranglerDirectory, "cwd.txt"),
    wranglerStdinPath: path.join(fakeWranglerDirectory, "stdin.txt"),
  };
}
