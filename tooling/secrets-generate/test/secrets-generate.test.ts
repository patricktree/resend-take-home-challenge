import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";

import { generateSecrets } from "#src/secrets-generate.ts";

const AGENT_TOKEN_PATTERN = /^agent_[\w-]{43}$/;
const REVIEWER_TOKEN_PATTERN = /^reviewer_[\w-]{43}$/;
const PLACEHOLDER_AGENT_TOKEN = "agent_placeholder-run-pnpm-secrets-generate";

const WRANGLER_CONFIG = `// The production config.
{
  "name": "draft-approval",
  "vars": {
    "LOCAL_DEVELOPMENT": "false",
    // The public Agent token.
    "AGENT_TOKEN": "${PLACEHOLDER_AGENT_TOKEN}",
  },
}
`;

const README = `# Email Draft Approval

The public Agent token: \`${PLACEHOLDER_AGENT_TOKEN}\`.

\`\`\`sh
curl -H 'Authorization: Bearer ${PLACEHOLDER_AGENT_TOKEN}' https://example.com
\`\`\`
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

test("writes a new Agent token into wrangler.jsonc and the README, keeping comments and formatting", async ({
  expect,
}) => {
  const repository = await createRepository(RECORDING_WRANGLER);

  await generateSecrets({
    repositoryRoot: repository.root,
    wranglerExecutable: repository.wranglerExecutable,
    print: () => {},
  });

  const config = await fs.readFile(repository.wranglerConfigPath, "utf8");
  const agentToken = /"AGENT_TOKEN": "(?<token>[^"]+)"/.exec(config)?.groups?.["token"];
  expect(agentToken).toMatch(AGENT_TOKEN_PATTERN);
  expect(config).toBe(WRANGLER_CONFIG.replace(PLACEHOLDER_AGENT_TOKEN, agentToken ?? ""));
  expect(await fs.readFile(repository.readmePath, "utf8")).toBe(
    README.replaceAll(PLACEHOLDER_AGENT_TOKEN, agentToken ?? ""),
  );
});

test("pipes a new Reviewer token into `wrangler secret put` over stdin, never as an argument", async ({
  expect,
}) => {
  const repository = await createRepository(RECORDING_WRANGLER);

  await generateSecrets({
    repositoryRoot: repository.root,
    wranglerExecutable: repository.wranglerExecutable,
    print: () => {},
  });

  const argv: unknown = JSON.parse(await fs.readFile(repository.wranglerArgvPath, "utf8"));
  expect(argv).toStrictEqual(["secret", "put", "REVIEWER_TOKEN"]);
  expect(await fs.readFile(repository.wranglerStdinPath, "utf8")).toMatch(REVIEWER_TOKEN_PATTERN);
  expect(await fs.realpath(await fs.readFile(repository.wranglerCwdPath, "utf8"))).toBe(
    await fs.realpath(repository.workerDirectory),
  );
});

test("prints the Reviewer token exactly once and never the Agent token", async ({ expect }) => {
  const repository = await createRepository(RECORDING_WRANGLER);
  const printed: string[] = [];

  await generateSecrets({
    repositoryRoot: repository.root,
    wranglerExecutable: repository.wranglerExecutable,
    print: (line) => printed.push(line),
  });

  const reviewerToken = await fs.readFile(repository.wranglerStdinPath, "utf8");
  const output = printed.join("\n");
  expect(output.split(reviewerToken)).toHaveLength(2);
  expect(output).not.toMatch(/agent_[\w-]{43}/);
});

test("fails without printing the Reviewer token when `wrangler secret put` fails", async ({
  expect,
}) => {
  const repository = await createRepository(FAILING_WRANGLER);
  const printed: string[] = [];

  const run = generateSecrets({
    repositoryRoot: repository.root,
    wranglerExecutable: repository.wranglerExecutable,
    print: (line) => printed.push(line),
  });

  await expect(run).rejects.toThrow("`wrangler secret put REVIEWER_TOKEN` exited with code 1.");
  expect(printed.join("\n")).not.toMatch(/reviewer_/);
});

test("refuses to run when the README does not show the configured Agent token", async ({
  expect,
}) => {
  const repository = await createRepository(RECORDING_WRANGLER);
  await fs.writeFile(repository.readmePath, "# Email Draft Approval\n");

  const run = generateSecrets({
    repositoryRoot: repository.root,
    wranglerExecutable: repository.wranglerExecutable,
    print: () => {},
  });

  await expect(run).rejects.toThrow("README.md does not show the configured Agent token");
  expect(await fs.readFile(repository.wranglerConfigPath, "utf8")).toBe(WRANGLER_CONFIG);
  await expect(fs.access(repository.wranglerArgvPath)).rejects.toThrow();
});

/** A temporary copy of the files the script touches, with a fake `wrangler` next to them. */
async function createRepository(wranglerScript: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secrets-generate-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));

  const workerDirectory = path.join(root, "apps", "cloudflare-worker");
  const wranglerConfigPath = path.join(workerDirectory, "wrangler.jsonc");
  const readmePath = path.join(root, "README.md");
  const fakeWranglerDirectory = path.join(root, "fake-wrangler");
  const wranglerExecutable = path.join(fakeWranglerDirectory, "wrangler.mjs");

  await fs.mkdir(workerDirectory, { recursive: true });
  await fs.mkdir(fakeWranglerDirectory);
  await fs.writeFile(wranglerConfigPath, WRANGLER_CONFIG);
  await fs.writeFile(readmePath, README);
  await fs.writeFile(wranglerExecutable, wranglerScript, { mode: 0o755 });

  return {
    root,
    workerDirectory,
    wranglerConfigPath,
    readmePath,
    wranglerExecutable,
    wranglerArgvPath: path.join(fakeWranglerDirectory, "argv.json"),
    wranglerCwdPath: path.join(fakeWranglerDirectory, "cwd.txt"),
    wranglerStdinPath: path.join(fakeWranglerDirectory, "stdin.txt"),
  };
}
