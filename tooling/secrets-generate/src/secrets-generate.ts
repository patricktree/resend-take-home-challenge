import * as jsonc from "jsonc-parser";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type GenerateSecretsOptions = {
  /** The repository whose `wrangler.jsonc` and `README.md` receive the Agent token. */
  repositoryRoot: string;
  /** The `wrangler` binary that sets the Reviewer token as a Worker secret. */
  wranglerExecutable: string;
  /** Receives the only output that contains a token: the Reviewer token, once. */
  print: (line: string) => void;
};

const AGENT_TOKEN_PATH = ["vars", "AGENT_TOKEN"];

/**
 * Creates a new Agent token and a new Reviewer token (spec section 7, "Credentials"). The Agent
 * token is public and goes into the committed files; the Reviewer token becomes the Worker secret
 * `REVIEWER_TOKEN` and is printed once, since it is never stored anywhere else.
 */
export async function generateSecrets({
  repositoryRoot,
  wranglerExecutable,
  print,
}: GenerateSecretsOptions): Promise<void> {
  const agentToken = generateToken("agent");
  const reviewerToken = generateToken("reviewer");

  await writeAgentToken(repositoryRoot, agentToken);
  print("Wrote the new Agent token into apps/cloudflare-worker/wrangler.jsonc and README.md.");

  try {
    await putWorkerSecret({
      wranglerExecutable,
      workerDirectory: getWorkerDirectory(repositoryRoot),
      secretName: "REVIEWER_TOKEN",
      secretValue: reviewerToken,
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "Setting REVIEWER_TOKEN failed."} wrangler.jsonc and README.md already hold the new Agent token; fix the cause and run the script again, or revert them.`,
      { cause: error },
    );
  }
  print(
    "Set the Worker secret REVIEWER_TOKEN. Store the Reviewer token now; it is not shown again:",
  );
  print(reviewerToken);
}

/** `agent_` or `reviewer_` followed by base64url of 32 random bytes. */
function generateToken(prefix: "agent" | "reviewer"): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

/**
 * Replaces the Agent token everywhere it is committed: the `AGENT_TOKEN` var of `wrangler.jsonc`
 * (edited in place, so comments and formatting survive) and every occurrence in `README.md`.
 */
async function writeAgentToken(repositoryRoot: string, agentToken: string): Promise<void> {
  const wranglerConfigPath = path.join(getWorkerDirectory(repositoryRoot), "wrangler.jsonc");
  const readmePath = path.join(repositoryRoot, "README.md");
  const wranglerConfig = await fs.readFile(wranglerConfigPath, "utf8");
  const readme = await fs.readFile(readmePath, "utf8");

  const configTree = jsonc.parseTree(wranglerConfig);
  const previousAgentToken: unknown =
    configTree && jsonc.findNodeAtLocation(configTree, AGENT_TOKEN_PATH)?.value;
  if (typeof previousAgentToken !== "string" || previousAgentToken === "") {
    throw new Error("wrangler.jsonc has no `vars.AGENT_TOKEN` to replace.");
  }
  if (!readme.includes(previousAgentToken)) {
    throw new Error(
      "README.md does not show the configured Agent token; restore it before generating new tokens.",
    );
  }

  const edits = jsonc.modify(wranglerConfig, AGENT_TOKEN_PATH, agentToken, {});
  await fs.writeFile(wranglerConfigPath, jsonc.applyEdits(wranglerConfig, edits));
  await fs.writeFile(readmePath, readme.replaceAll(previousAgentToken, agentToken));
}

type PutWorkerSecretOptions = {
  wranglerExecutable: string;
  workerDirectory: string;
  secretName: string;
  secretValue: string;
};

/** Runs `wrangler secret put` with the value on stdin, so it never shows up in a process list. */
async function putWorkerSecret({
  wranglerExecutable,
  workerDirectory,
  secretName,
  secretValue,
}: PutWorkerSecretOptions): Promise<void> {
  const wrangler = childProcess.spawn(wranglerExecutable, ["secret", "put", secretName], {
    cwd: workerDirectory,
    stdio: ["pipe", "inherit", "inherit"],
  });
  wrangler.stdin.end(secretValue);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    wrangler.once("error", reject);
    wrangler.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`\`wrangler secret put ${secretName}\` exited with code ${exitCode}.`);
  }
}

function getWorkerDirectory(repositoryRoot: string): string {
  return path.join(repositoryRoot, "apps", "cloudflare-worker");
}
