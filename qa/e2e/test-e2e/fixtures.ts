import { test as base, type TestInfo } from "@playwright/test";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import util from "node:util";

import { DraftApprovalClient } from "@draft-approval/api.client";
import { LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN } from "@draft-approval/api.routes";

type ReviewEnvironment = {
  /**
   * The Worker's origin as the browser sees it. The browser runs in Docker and reaches the host as
   * `host.docker.internal`, one of the hosts on which the Worker accepts the local tokens.
   */
  browserOrigin: string;
  /** Plays the Agent's moves, with the local Agent token. */
  agentClient: DraftApprovalClient;
  /** Renders verdicts for test setup, with the local Reviewer token. */
  reviewerClient: DraftApprovalClient;
};

type Fixtures = {
  reviewEnvironment: ReviewEnvironment;
};

export { expect } from "@playwright/test";

const E2E_DIRECTORY = path.resolve(import.meta.dirname, "..");
const WRANGLER_BIN = path.join(E2E_DIRECTORY, "node_modules/.bin/wrangler");

/** Wrangler prints this once the Worker listens; with `--port 0` it names the port the OS chose. */
const READY_LINE_PATTERN = /Ready on http:\/\/127\.0\.0\.1:(?<port>\d+)/;
const WRANGLER_START_TIMEOUT_MS = 30_000;
const WRANGLER_STOP_TIMEOUT_MS = 10_000;

const execFile = util.promisify(childProcess.execFile);

export const test = base.extend<Fixtures>({
  // Playwright reads a fixture's dependencies from the destructuring pattern, which may not be empty.
  reviewEnvironment: async ({ browserName: _browserName }, use, testInfo) => {
    const worker = await startWorker();
    try {
      const hostOrigin = `http://127.0.0.1:${worker.port}`;
      await use({
        browserOrigin: `http://host.docker.internal:${worker.port}`,
        agentClient: new DraftApprovalClient({ baseUrl: hostOrigin, token: LOCAL_AGENT_TOKEN }),
        reviewerClient: new DraftApprovalClient({
          baseUrl: hostOrigin,
          token: LOCAL_REVIEWER_TOKEN,
        }),
      });
    } finally {
      await worker.stop(testInfo);
    }
  },
  baseURL: async ({ reviewEnvironment }, use) => {
    await use(reviewEnvironment.browserOrigin);
  },
});

type RunningWorker = {
  port: number;
  stop: (testInfo: TestInfo) => Promise<void>;
};

/**
 * Starts the Worker with `wrangler dev` on a port the OS assigns, with its own empty persistence
 * directory and the D1 migrations applied.
 */
async function startWorker(): Promise<RunningWorker> {
  const persistenceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "draft-approval-e2e-"));
  const environment = createWranglerEnvironment();
  const output: string[] = [];

  await execFile(
    WRANGLER_BIN,
    ["d1", "migrations", "apply", "DB", "--local", "--persist-to", persistenceDirectory],
    { cwd: E2E_DIRECTORY, env: environment },
  );

  const wranglerProcess = childProcess.spawn(
    WRANGLER_BIN,
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "0",
      "--inspector-port",
      "0",
      "--persist-to",
      persistenceDirectory,
      "--show-interactive-dev-session=false",
    ],
    // Its own process group, so stopping it also stops the workerd processes it starts.
    { cwd: E2E_DIRECTORY, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  wranglerProcess.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
  wranglerProcess.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));

  const stop = async (testInfo: TestInfo): Promise<void> => {
    await stopProcessGroup(wranglerProcess);
    await fs.rm(persistenceDirectory, { recursive: true, force: true });
    await testInfo.attach("wrangler-output", { body: output.join(""), contentType: "text/plain" });
  };

  try {
    const port = await waitForReadyPort(wranglerProcess, output);
    return { port, stop };
  } catch (error) {
    await stopProcessGroup(wranglerProcess);
    await fs.rm(persistenceDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** The tests' own environment, without Cloudflare credentials: nothing may reach a real account. */
function createWranglerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment["CLOUDFLARE_API_TOKEN"];
  delete environment["CLOUDFLARE_API_KEY"];
  delete environment["CLOUDFLARE_ACCOUNT_ID"];
  environment["WRANGLER_SEND_METRICS"] = "false";
  return environment;
}

async function waitForReadyPort(
  wranglerProcess: childProcess.ChildProcess,
  output: string[],
): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();

  const timeout = setTimeout(
    () => reject(new Error(`wrangler dev did not get ready:\n${output.join("")}`)),
    WRANGLER_START_TIMEOUT_MS,
  );
  const handleOutput = (): void => {
    const port = READY_LINE_PATTERN.exec(util.stripVTControlCharacters(output.join("")))?.groups?.[
      "port"
    ];
    if (port !== undefined) {
      resolve(Number(port));
    }
  };
  const handleExit = (): void =>
    reject(new Error(`wrangler dev exited before it got ready:\n${output.join("")}`));

  wranglerProcess.stdout?.on("data", handleOutput);
  wranglerProcess.once("exit", handleExit);
  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
    wranglerProcess.stdout?.off("data", handleOutput);
    wranglerProcess.off("exit", handleExit);
  }
}

async function stopProcessGroup(childProcessToStop: childProcess.ChildProcess): Promise<void> {
  if (childProcessToStop.exitCode !== null || childProcessToStop.signalCode !== null) {
    return;
  }

  const exited = once(childProcessToStop, "exit");
  killProcessGroup(childProcessToStop, "SIGTERM");
  const forceKill = setTimeout(
    () => killProcessGroup(childProcessToStop, "SIGKILL"),
    WRANGLER_STOP_TIMEOUT_MS,
  );
  await exited;
  clearTimeout(forceKill);
}

function killProcessGroup(
  childProcessToKill: childProcess.ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (childProcessToKill.pid === undefined) {
    throw new Error("wrangler dev has no process id.");
  }
  try {
    // A negative pid addresses the process group.
    process.kill(-childProcessToKill.pid, signal);
  } catch (error) {
    const isAlreadyGone = error instanceof Error && "code" in error && error.code === "ESRCH";
    if (!isAlreadyGone) {
      throw error;
    }
  }
}
