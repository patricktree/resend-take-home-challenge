import childProcess from "node:child_process";
import crypto from "node:crypto";

export type GenerateSecretsOptions = {
  /**
   * The Worker's directory: `wrangler` runs there, so the secrets land on the Worker its
   * `wrangler.jsonc` names.
   */
  workerDirectory: string;
  /** The `wrangler` binary that sets both tokens as Worker secrets. */
  wranglerExecutable: string;
  /** Receives the only output that contains a token: both tokens, once each. */
  print: (line: string) => void;
};

/**
 * Creates a new Agent token and a new Reviewer token (spec section 7, "Credentials"), sets them as
 * the Worker secrets `AGENT_TOKEN` and `REVIEWER_TOKEN` and prints both once, since neither is
 * stored anywhere else. It changes no file.
 */
export async function generateSecrets({
  workerDirectory,
  wranglerExecutable,
  print,
}: GenerateSecretsOptions): Promise<void> {
  const agentToken = generateToken("agent");
  const reviewerToken = generateToken("reviewer");

  await putWorkerSecrets({
    wranglerExecutable,
    workerDirectory,
    secrets: { AGENT_TOKEN: agentToken, REVIEWER_TOKEN: reviewerToken },
  });

  print(
    "Set the Worker secrets AGENT_TOKEN and REVIEWER_TOKEN. Store both tokens now; they are not shown again.",
  );
  print(`Agent token:    ${agentToken}`);
  print(`Reviewer token: ${reviewerToken}`);
}

/** `agent_` or `reviewer_` followed by base64url of 32 random bytes. */
function generateToken(prefix: "agent" | "reviewer"): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

type PutWorkerSecretsOptions = {
  wranglerExecutable: string;
  workerDirectory: string;
  secrets: Record<string, string>;
};

/**
 * Runs one `wrangler secret bulk` with the secrets as JSON on stdin, so no value shows up in a
 * process list.
 */
async function putWorkerSecrets({
  wranglerExecutable,
  workerDirectory,
  secrets,
}: PutWorkerSecretsOptions): Promise<void> {
  const wrangler = childProcess.spawn(wranglerExecutable, ["secret", "bulk"], {
    cwd: workerDirectory,
    stdio: ["pipe", "inherit", "inherit"],
  });
  wrangler.stdin.end(JSON.stringify(secrets));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    wrangler.once("error", reject);
    wrangler.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `\`wrangler secret bulk\` exited with code ${exitCode}. No token was printed; fix the cause and run the script again.`,
    );
  }
}
