import { test as base, type TestInfo } from "@playwright/test";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import util from "node:util";

import { DraftApprovalClient } from "@draft-approval/api.client";
import { LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN } from "@draft-approval/api.routes";
import { startResendStub, type ResendStub } from "@draft-approval/resend-stub";

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
  /** The test's own Resend stub, which the Worker's Queue consumer sends every email to. */
  resendStub: ResendStub;
  /**
   * Runs SQL on the Worker's local D1 database with `wrangler d1 execute`, for a state no API
   * request reaches within a test, such as a Send that ended as `OUTCOME_UNKNOWN`.
   */
  executeSql: (sql: string) => Promise<void>;
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

/** The dummy `RESEND_API_KEY` of every test Worker; only the test's Resend stub receives it. */
const TEST_RESEND_API_KEY = "re_e2e-dummy-resend-api-key";

const execFile = util.promisify(childProcess.execFile);

export const test = base.extend<Fixtures>({
  // Playwright reads a fixture's dependencies from the destructuring pattern, which may not be empty.
  reviewEnvironment: async ({ browserName: _browserName }, use, testInfo) => {
    // On the host, like `wrangler dev`, which reaches it on 127.0.0.1.
    const resendStub = await startResendStub();
    try {
      const worker = await startWorker(resendStub.url);
      try {
        const hostOrigin = `http://127.0.0.1:${worker.port}`;
        await use({
          browserOrigin: `http://host.docker.internal:${worker.port}`,
          agentClient: new DraftApprovalClient({ baseUrl: hostOrigin, token: LOCAL_AGENT_TOKEN }),
          reviewerClient: new DraftApprovalClient({
            baseUrl: hostOrigin,
            token: LOCAL_REVIEWER_TOKEN,
          }),
          resendStub,
          executeSql: worker.executeSql,
        });
      } finally {
        await worker.stop(testInfo);
      }
    } finally {
      await resendStub.close();
    }
  },
  baseURL: async ({ reviewEnvironment }, use) => {
    await use(reviewEnvironment.browserOrigin);
  },
});

type RunningWorker = {
  port: number;
  executeSql: (sql: string) => Promise<void>;
  stop: (testInfo: TestInfo) => Promise<void>;
};

/**
 * Starts the Worker with `wrangler dev` on a port the OS assigns, with its own empty persistence
 * directory and the D1 migrations applied. It sends emails to the Resend stub at `resendBaseUrl`.
 */
async function startWorker(resendBaseUrl: string): Promise<RunningWorker> {
  const persistenceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "draft-approval-e2e-"));
  const removePersistenceDirectory = () =>
    fs.rm(persistenceDirectory, { recursive: true, force: true });

  try {
    const { port, output, wranglerProcess } = await startWranglerDev(
      persistenceDirectory,
      resendBaseUrl,
    );
    return {
      port,
      executeSql: async (sql) => {
        await execFile(
          WRANGLER_BIN,
          [
            "d1",
            "execute",
            "DB",
            "--local",
            "--persist-to",
            persistenceDirectory,
            "--command",
            sql,
          ],
          { cwd: E2E_DIRECTORY, env: createWranglerEnvironment() },
        );
      },
      stop: async (testInfo) => {
        await stopProcessGroup(wranglerProcess);
        await removePersistenceDirectory();
        await testInfo.attach("wrangler-output", {
          body: output.join(""),
          contentType: "text/plain",
        });
      },
    };
  } catch (error) {
    await removePersistenceDirectory();
    throw error;
  }
}

async function startWranglerDev(persistenceDirectory: string, resendBaseUrl: string) {
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
      "--var",
      `RESEND_BASE_URL:${resendBaseUrl}`,
      "--var",
      `RESEND_API_KEY:${TEST_RESEND_API_KEY}`,
    ],
    // Its own process group, so stopping it also stops the workerd processes it starts.
    { cwd: E2E_DIRECTORY, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  wranglerProcess.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
  wranglerProcess.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));

  try {
    const port = await waitForReadyPort(wranglerProcess, output);
    return { port, output, wranglerProcess };
  } catch (error) {
    await stopProcessGroup(wranglerProcess);
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
