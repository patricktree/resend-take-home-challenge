import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { test } from "vitest";

import { getUnreachableUrl, useApiStub, type StubResponse } from "./api-stub.ts";

const CLI_PATH = url.fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const DRAFTS_COMMANDS = ["create", "get", "list", "revise", "submit", "revision"];

/** An `approve` or `reject` command or option line in a help text; prose may still mention verdicts. */
const VERDICT_COMMAND_OR_OPTION_PATTERN =
  /^ {2}(?:--)?(?:approve|reject)\b|--(?:approve|reject)\b/im;

/** Distinctive, so a test can tell it apart from any other text in the output. */
const AGENT_TOKEN = "agent_cli-process-test-token-6f1d0c";

const DRAFT_ID = "drf_019a0b7e-5c3d-7f2a-9b1e-4d6c8a2f0e13";
const REVISION_ID = "rev_019a0b7e-5c3d-7f2a-9b1e-4d6c8a2f0e14";
const NEXT_REVISION_ID = "rev_019a0b7e-6000-7f2a-9b1e-4d6c8a2f0e15";
const REVIEW_URL = `https://resend-challenge.patricktree.me/app/drafts/${DRAFT_ID}`;

const DRAFT_SUMMARY = {
  id: DRAFT_ID,
  createdAt: "2026-10-21T08:00:00.000Z",
  lastActionAt: "2026-10-21T08:00:00.000Z",
  reviewStatus: "UNSUBMITTED",
  latestRevision: {
    id: REVISION_ID,
    revisionNumber: 1,
    createdAt: "2026-10-21T08:00:00.000Z",
    to: ["ada@example.com", "grace@example.com"],
    subject: "Quarterly report",
    reviewStatus: "UNSUBMITTED",
  },
  sending: { status: "NOT_SENT" },
  reviewUrl: REVIEW_URL,
};

const DRAFT = {
  ...DRAFT_SUMMARY,
  latestRevision: {
    ...DRAFT_SUMMARY.latestRevision,
    body: { plainText: "Hello Ada and Grace,\n\nthe report is attached." },
  },
};

const REJECTED_REVISION = {
  ...DRAFT.latestRevision,
  reviewStatus: "REJECTED",
  submittedAt: "2026-10-21T08:05:00.000Z",
  decidedAt: "2026-10-21T08:10:00.000Z",
  rejectionReason: "Attach the report.",
};

const SUPERSEDED_ERROR: StubResponse = {
  status: 409,
  body: {
    error: {
      code: "REVISION_SUPERSEDED",
      message: "The Revision is not the Draft's latest Revision.",
      requestId: "req_superseded",
    },
  },
};

test("the root help lists only the drafts commands, names the token variable and links the OpenAPI document", async ({
  expect,
}) => {
  const result = await runCli(["--help"]);

  expect(result.exitCode).toBe(0);
  expect(listHelpCommands(result.stdout)).toStrictEqual(["drafts", "help"]);
  expect(result.stdout).not.toMatch(VERDICT_COMMAND_OR_OPTION_PATTERN);
  expect(result.stdout).toContain("RESEND_CHALLENGE_TOKEN");
  expect(result.stdout).toContain("https://resend-challenge.patricktree.me/api/openapi.json");
});

test("the drafts help lists the six Agent commands and no verdict command", async ({ expect }) => {
  const result = await runCli(["drafts", "--help"]);

  expect(result.exitCode).toBe(0);
  expect(listHelpCommands(result.stdout)).toStrictEqual([...DRAFTS_COMMANDS, "help"]);
});

test.for(DRAFTS_COMMANDS)(
  "`drafts %s --help` describes the command",
  async (command, { expect }) => {
    const result = await runCli(["drafts", command, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Usage: resend-challenge drafts ${command}`);
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--api-url");
    expect(result.stdout).not.toMatch(VERDICT_COMMAND_OR_OPTION_PATTERN);
  },
);

test.for(["approve", "reject"])(
  "`drafts %s` is an unknown command",
  async (command, { expect }) => {
    const result = await runCli(["drafts", command]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toStrictEqual({
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("unknown command") },
    });
  },
);

test("`drafts create` sends the Draft data with RESEND_CHALLENGE_TOKEN, and --json prints the Draft summary", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 201, body: DRAFT_SUMMARY }));

  const result = await runCli(
    [
      "drafts",
      "create",
      "--to",
      "ada@example.com",
      "--to",
      "grace@example.com",
      "--subject",
      "Quarterly report",
      "--body",
      "Hello Ada and Grace,\n\nthe report is attached.",
      "--json",
    ],
    { env: { RESEND_CHALLENGE_TOKEN: AGENT_TOKEN, RESEND_CHALLENGE_API_URL: api.url } },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toStrictEqual(DRAFT_SUMMARY);
  expect(api.requests).toStrictEqual([
    {
      method: "POST",
      pathname: "/api/v1/drafts",
      query: [],
      authorization: `Bearer ${AGENT_TOKEN}`,
      body: {
        to: ["ada@example.com", "grace@example.com"],
        subject: "Quarterly report",
        body: { plainText: "Hello Ada and Grace,\n\nthe report is attached." },
      },
    },
  ]);
});

test.for([
  ["unset", undefined],
  ["empty", ""],
] as const)(
  "with RESEND_CHALLENGE_TOKEN %s the CLI fails naming the variable, before any request",
  async ([, token], { expect, onTestFinished }) => {
    const api = await useApiStub(onTestFinished, () => ({ status: 200, body: DRAFT }));

    const result = await runCli(["drafts", "get", DRAFT_ID], {
      env: { RESEND_CHALLENGE_TOKEN: token, RESEND_CHALLENGE_API_URL: api.url },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toStrictEqual({
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("RESEND_CHALLENGE_TOKEN"),
      },
    });
    expect(api.requests).toStrictEqual([]);
  },
);

test("`drafts create` prints the ids, the statuses and the reviewUrl", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 201, body: DRAFT_SUMMARY }));

  const result = await runCli(
    ["drafts", "create", "--to", "ada@example.com", "--subject", "Hi", "--body", "Hello"],
    { env: { RESEND_CHALLENGE_API_URL: api.url } },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    [
      `Draft ${DRAFT_ID}`,
      "Review status: UNSUBMITTED",
      "Sending status: NOT_SENT",
      `Latest Revision: ${REVISION_ID} (Revision 1, UNSUBMITTED)`,
      `Review URL: ${REVIEW_URL}`,
      "",
    ].join("\n"),
  );
});

test("`drafts create --body-file` reads the body from a file", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 201, body: DRAFT_SUMMARY }));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "resend-challenge-cli-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const bodyPath = path.join(directory, "body.txt");
  await fs.writeFile(bodyPath, "Hello from a file.\n");

  const result = await runCli(
    ["drafts", "create", "--to", "ada@example.com", "--subject", "Hi", "--body-file", bodyPath],
    { env: { RESEND_CHALLENGE_API_URL: api.url } },
  );

  expect(result.exitCode).toBe(0);
  expect(api.requests[0]?.body).toStrictEqual({
    to: ["ada@example.com"],
    subject: "Hi",
    body: { plainText: "Hello from a file.\n" },
  });
});

// `pnpm resend-challenge` runs the CLI in the repository root and keeps the caller's directory in INIT_CWD.
test("`drafts create --body-file` resolves a relative path against the directory pnpm was called from", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 201, body: DRAFT_SUMMARY }));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "resend-challenge-cli-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "body.txt"), "Hello from the caller's directory.\n");

  const result = await runCli(
    ["drafts", "create", "--to", "ada@example.com", "--subject", "Hi", "--body-file", "body.txt"],
    { env: { RESEND_CHALLENGE_API_URL: api.url, INIT_CWD: directory } },
  );

  expect(result.exitCode).toBe(0);
  expect(api.requests[0]?.body).toMatchObject({
    body: { plainText: "Hello from the caller's directory.\n" },
  });
});

test("`drafts revise --body-file -` reads the body from stdin and sends the base Revision", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 201, body: DRAFT_SUMMARY }));

  const result = await runCli(
    [
      "drafts",
      "revise",
      DRAFT_ID,
      "--base-revision",
      REVISION_ID,
      "--to",
      "ada@example.com",
      "--subject",
      "Quarterly report, revised",
      "--body-file",
      "-",
    ],
    { env: { RESEND_CHALLENGE_API_URL: api.url }, stdin: "Hello from stdin.\n" },
  );

  expect(result.exitCode).toBe(0);
  expect(api.requests).toMatchObject([
    {
      method: "POST",
      pathname: `/api/v1/drafts/${DRAFT_ID}/revisions`,
      body: {
        baseRevisionId: REVISION_ID,
        to: ["ada@example.com"],
        subject: "Quarterly report, revised",
        body: { plainText: "Hello from stdin.\n" },
      },
    },
  ]);
});

test("a 409 prints its code and message as JSON on stderr and exits with 1", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => SUPERSEDED_ERROR);

  const result = await runCli(
    [
      "drafts",
      "revise",
      DRAFT_ID,
      "--base-revision",
      REVISION_ID,
      "--to",
      "ada@example.com",
      "--subject",
      "Hi",
      "--body",
      "Hello",
    ],
    { env: { RESEND_CHALLENGE_API_URL: api.url } },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toStrictEqual({
    error: {
      code: "REVISION_SUPERSEDED",
      message: "The Revision is not the Draft's latest Revision.",
      requestId: "req_superseded",
    },
  });
});

test("`drafts get` prints the recipients, the subject and the body", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 200, body: DRAFT }));

  const result = await runCli(["drafts", "get", DRAFT_ID], {
    env: { RESEND_CHALLENGE_API_URL: api.url },
  });

  expect(result.exitCode).toBe(0);
  expect(api.requests).toMatchObject([{ method: "GET", pathname: `/api/v1/drafts/${DRAFT_ID}` }]);
  expect(result.stdout).toBe(
    [
      `Draft ${DRAFT_ID}`,
      "Review status: UNSUBMITTED",
      "Sending status: NOT_SENT",
      `Latest Revision: ${REVISION_ID} (Revision 1, UNSUBMITTED)`,
      `Review URL: ${REVIEW_URL}`,
      "",
      "To: ada@example.com, grace@example.com",
      "Subject: Quarterly report",
      "",
      "Hello Ada and Grace,",
      "",
      "the report is attached.",
      "",
    ].join("\n"),
  );
});

test("`drafts list` sends every filter, the ordering and the paging, and prints the next cursor", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({
    status: 200,
    body: { items: [DRAFT_SUMMARY], nextCursor: "cursor_2" },
  }));

  const result = await runCli(
    [
      "drafts",
      "list",
      "--review-status",
      "PENDING",
      "--review-status",
      "REJECTED",
      "--sending-status",
      "NOT_SENT",
      "--order-by",
      "createdAt",
      "--order",
      "asc",
      "--limit",
      "10",
      "--cursor",
      "cursor_1",
    ],
    { env: { RESEND_CHALLENGE_API_URL: api.url } },
  );

  expect(result.exitCode).toBe(0);
  expect(api.requests).toMatchObject([{ method: "GET", pathname: "/api/v1/drafts" }]);
  expect(api.requests[0]?.query.toSorted()).toStrictEqual([
    ["cursor", "cursor_1"],
    ["limit", "10"],
    ["order", "asc"],
    ["orderBy", "createdAt"],
    ["reviewStatus", "PENDING"],
    ["reviewStatus", "REJECTED"],
    ["sendingStatus", "NOT_SENT"],
  ]);
  expect(result.stdout).toContain(`Draft ${DRAFT_ID}\n`);
  expect(result.stdout).toContain("Subject: Quarterly report\n");
  expect(result.stdout).toContain(`Review URL: ${REVIEW_URL}\n`);
  expect(result.stdout).toContain("--cursor cursor_2");
});

test("`drafts list --json` prints the page", async ({ expect, onTestFinished }) => {
  const page = { items: [DRAFT_SUMMARY] };
  const api = await useApiStub(onTestFinished, () => ({ status: 200, body: page }));

  const result = await runCli(["--json", "drafts", "list"], {
    env: { RESEND_CHALLENGE_API_URL: api.url },
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toStrictEqual(page);
});

test("`drafts submit` submits the Revision", async ({ expect, onTestFinished }) => {
  const submitted = { ...DRAFT_SUMMARY, reviewStatus: "PENDING" };
  const api = await useApiStub(onTestFinished, () => ({ status: 200, body: submitted }));

  const result = await runCli(["drafts", "submit", DRAFT_ID, REVISION_ID, "--json"], {
    env: { RESEND_CHALLENGE_API_URL: api.url },
  });

  expect(result.exitCode).toBe(0);
  expect(api.requests).toMatchObject([
    {
      method: "POST",
      pathname: `/api/v1/drafts/${DRAFT_ID}/revisions/${REVISION_ID}/submission`,
      body: undefined,
    },
  ]);
  expect(JSON.parse(result.stdout)).toStrictEqual(submitted);
});

test("`drafts revision` prints the Revision with its rejection reason and body", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 200, body: REJECTED_REVISION }));

  const result = await runCli(["drafts", "revision", DRAFT_ID, REVISION_ID], {
    env: { RESEND_CHALLENGE_API_URL: api.url },
  });

  expect(result.exitCode).toBe(0);
  expect(api.requests).toMatchObject([
    { method: "GET", pathname: `/api/v1/drafts/${DRAFT_ID}/revisions/${REVISION_ID}` },
  ]);
  expect(result.stdout).toBe(
    [
      `Revision ${REVISION_ID} (Revision 1)`,
      "Review status: REJECTED",
      "Rejection reason: Attach the report.",
      "",
      "To: ada@example.com, grace@example.com",
      "Subject: Quarterly report",
      "",
      "Hello Ada and Grace,",
      "",
      "the report is attached.",
      "",
    ].join("\n"),
  );
});

test.for([
  ["a human result", ["drafts", "get", DRAFT_ID], { status: 200, body: DRAFT }],
  ["a JSON result", ["drafts", "get", DRAFT_ID, "--json"], { status: 200, body: DRAFT }],
  ["an API error", ["drafts", "submit", DRAFT_ID, NEXT_REVISION_ID], SUPERSEDED_ERROR],
  [
    "an authentication error",
    ["drafts", "list"],
    {
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "Unauthenticated.", requestId: "req_1" } },
    },
  ],
] as const)(
  "the token never appears in the output of %s",
  async ([, args, response], { expect, onTestFinished }) => {
    const api = await useApiStub(onTestFinished, () => response);

    const result = await runCli([...args], {
      env: { RESEND_CHALLENGE_TOKEN: AGENT_TOKEN, RESEND_CHALLENGE_API_URL: api.url },
    });

    expect(api.requests).toHaveLength(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(AGENT_TOKEN);
    expect(`${result.stdout}${result.stderr}`).not.toContain(AGENT_TOKEN.slice("agent_".length));
  },
);

test.for([
  [
    "an invalid recipient",
    ["drafts", "create", "--to", "not-an-address", "--subject", "Hi", "--body", "Hello"],
  ],
  ["a missing body", ["drafts", "create", "--to", "ada@example.com", "--subject", "Hi"]],
  [
    "both body options",
    [
      "drafts",
      "create",
      "--to",
      "ada@example.com",
      "--subject",
      "Hi",
      "--body",
      "Hello",
      "--body-file",
      "-",
    ],
  ],
  ["a missing subject", ["drafts", "create", "--to", "ada@example.com", "--body", "Hello"]],
  [
    "a subject with a line break",
    ["drafts", "create", "--to", "ada@example.com", "--subject", "Hi\nthere", "--body", "Hello"],
  ],
  [
    "an invalid base Revision id",
    [
      "drafts",
      "revise",
      DRAFT_ID,
      "--base-revision",
      "rev_1",
      "--to",
      "ada@example.com",
      "--subject",
      "Hi",
      "--body",
      "Hello",
    ],
  ],
  ["an invalid Draft id", ["drafts", "get", "drf_1"]],
  ["an invalid Revision id", ["drafts", "submit", DRAFT_ID, "rev_1"]],
  ["a missing Revision id", ["drafts", "revision", DRAFT_ID]],
  ["a limit above 100", ["drafts", "list", "--limit", "500"]],
  ["an unknown review status", ["drafts", "list", "--review-status", "SUPERSEDED"]],
  ["an unknown option", ["drafts", "list", "--approve"]],
] as const)(
  "%s fails with INVALID_REQUEST before any request",
  async ([, args], { expect, onTestFinished }) => {
    const api = await useApiStub(onTestFinished);

    const result = await runCli([...args], { env: { RESEND_CHALLENGE_API_URL: api.url } });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(api.requests).toStrictEqual([]);
  },
);

test("an invalid recipient's error names the option and the address, and lists the schema's issues", async ({
  expect,
}) => {
  const result = await runCli([
    "drafts",
    "create",
    "--to",
    "ada@example.com",
    "--to",
    "not-an-address",
    "--subject",
    "Hi",
    "--body",
    "Hello",
  ]);

  expect(JSON.parse(result.stderr)).toStrictEqual({
    error: {
      code: "INVALID_REQUEST",
      message: 'Invalid input. --to "not-an-address": Must be a valid email address.',
      issues: [{ path: ["to", 1], message: "Must be a valid email address." }],
    },
  });
});

test.for([
  [
    "an invalid Draft id names the positional argument",
    ["drafts", "get", "drf_1"],
    "Invalid input. <draftId>: Must be a Draft id (drf_…).",
  ],
  [
    "an invalid base Revision id names --base-revision",
    [
      "drafts",
      "revise",
      DRAFT_ID,
      "--base-revision",
      "rev_1",
      "--to",
      "ada@example.com",
      "--subject",
      "Hi",
      "--body",
      "Hello",
    ],
    "Invalid input. --base-revision: Must be a Revision id (rev_…).",
  ],
  [
    "a limit above 100 names --limit",
    ["drafts", "list", "--limit", "500"],
    "Invalid input. --limit: Too big: expected number to be <=100.",
  ],
] as const)("%s", async ([, args, message], { expect }) => {
  const result = await runCli([...args]);

  expect(JSON.parse(result.stderr)).toMatchObject({
    error: { code: "INVALID_REQUEST", message },
  });
});

test("an error with several issues separates them in its message", async ({ expect }) => {
  const result = await runCli([
    "drafts",
    "create",
    "--to",
    "not-an-address",
    "--subject",
    "Hi\nthere",
    "--body",
    "Hello",
  ]);

  expect(JSON.parse(result.stderr)).toMatchObject({
    error: {
      code: "INVALID_REQUEST",
      message:
        'Invalid input. --to "not-an-address": Must be a valid email address; --subject: Must not contain line breaks.',
    },
  });
});

test("an invalid body read with --body-file names --body-file", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "resend-challenge-cli-"));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const bodyPath = path.join(directory, "body.txt");
  await fs.writeFile(bodyPath, "");

  const result = await runCli([
    "drafts",
    "create",
    "--to",
    "ada@example.com",
    "--subject",
    "Hi",
    "--body-file",
    bodyPath,
  ]);

  expect(JSON.parse(result.stderr)).toMatchObject({
    error: {
      code: "INVALID_REQUEST",
      message: "Invalid input. --body-file: Must not be empty.",
    },
  });
});

test.for([
  ["--api-url", { args: ["--api-url", "http://resend-challenge.patricktree.me"], env: {} }],
  [
    "RESEND_CHALLENGE_API_URL",
    { args: [], env: { RESEND_CHALLENGE_API_URL: "http://resend-challenge.patricktree.me" } },
  ],
] as const)(
  "a plain-HTTP API URL off loopback from %s is refused",
  async ([, { args, env }], { expect }) => {
    const result = await runCli([...args, "drafts", "get", DRAFT_ID], { env });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toStrictEqual({
      error: {
        code: "INVALID_REQUEST",
        message:
          'The API URL "http://resend-challenge.patricktree.me" must use HTTPS; plain HTTP is allowed only on localhost, 127.0.0.1 and [::1].',
      },
    });
  },
);

// Nothing listens on the port, so reaching the network step shows the URL passed the HTTPS check.
test.for(["localhost", "[::1]"])("plain HTTP on %s is allowed", async (hostname, { expect }) => {
  const { port } = new URL(await getUnreachableUrl());

  const result = await runCli(["drafts", "get", DRAFT_ID], {
    env: { RESEND_CHALLENGE_API_URL: `http://${hostname}:${port}` },
  });

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "NETWORK_ERROR" } });
});

test("an API URL with a path is refused rather than cut to its origin", async ({ expect }) => {
  const result = await runCli([
    "--api-url",
    "https://resend-challenge.patricktree.me/api/v1",
    "drafts",
    "get",
    DRAFT_ID,
  ]);

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toStrictEqual({
    error: {
      code: "INVALID_REQUEST",
      message:
        'The API URL "https://resend-challenge.patricktree.me/api/v1" must be an origin, such as https://resend-challenge.patricktree.me, without a path.',
    },
  });
});

test("--api-url takes precedence over RESEND_CHALLENGE_API_URL", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 200, body: DRAFT }));

  const result = await runCli(["drafts", "get", DRAFT_ID, "--api-url", api.url], {
    env: { RESEND_CHALLENGE_API_URL: "http://resend-challenge.patricktree.me" },
  });

  expect(result.exitCode).toBe(0);
  expect(api.requests).toHaveLength(1);
});

test("`drafts get` prints the last verdict and the sending outcome", async ({
  expect,
  onTestFinished,
}) => {
  const decidedDraft = {
    ...DRAFT,
    reviewStatus: "APPROVED",
    latestRevision: { ...DRAFT.latestRevision, revisionNumber: 2, reviewStatus: "APPROVED" },
    lastVerdict: {
      revisionId: REVISION_ID,
      revisionNumber: 2,
      verdict: "APPROVED",
      decidedAt: "2026-10-21T08:10:00.000Z",
    },
    sending: {
      status: "FAILED",
      failure: {
        reason: "REJECTED_BY_RESEND",
        resendErrorName: "validation_error",
        resendErrorMessage: "Invalid recipient.",
      },
    },
  };
  const api = await useApiStub(onTestFinished, () => ({ status: 200, body: decidedDraft }));

  const result = await runCli(["drafts", "get", DRAFT_ID], {
    env: { RESEND_CHALLENGE_API_URL: api.url },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    [
      "Review status: APPROVED",
      "Sending status: FAILED (REJECTED_BY_RESEND: validation_error: Invalid recipient.)",
      `Latest Revision: ${REVISION_ID} (Revision 2, APPROVED)`,
      "Last verdict: APPROVED on Revision 2",
      `Review URL: ${REVIEW_URL}`,
    ].join("\n"),
  );
});

test("a response without the API's error envelope fails with UNEXPECTED_ERROR", async ({
  expect,
  onTestFinished,
}) => {
  const api = await useApiStub(onTestFinished, () => ({ status: 502, body: "Bad Gateway" }));

  const result = await runCli(["drafts", "get", DRAFT_ID], {
    env: { RESEND_CHALLENGE_API_URL: api.url },
  });

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toStrictEqual({
    error: {
      code: "UNEXPECTED_ERROR",
      message: "The API answered with status 502 and no error envelope.",
    },
  });
});

test("an unreachable API fails with NETWORK_ERROR", async ({ expect }) => {
  const unreachableUrl = await getUnreachableUrl();

  const result = await runCli(["drafts", "get", DRAFT_ID], {
    env: { RESEND_CHALLENGE_API_URL: unreachableUrl },
  });

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toStrictEqual({
    error: {
      code: "NETWORK_ERROR",
      message: expect.stringContaining(`Could not reach the API at ${unreachableUrl}`),
    },
  });
});

type CliResult = { exitCode: number | null; stdout: string; stderr: string };

type RunCliOptions = {
  /**
   * The CLI's whole environment; nothing leaks in from the environment of the test run.
   * `RESEND_CHALLENGE_TOKEN` is `AGENT_TOKEN` unless set here; `undefined` leaves a variable
   * unset.
   */
  env?: Record<string, string | undefined>;
  stdin?: string;
};

/** Spawns the real `resend-challenge` process, as `pnpm resend-challenge` does. */
async function runCli(args: string[], { env = {}, stdin = "" }: RunCliOptions = {}) {
  const cliEnvironment = Object.fromEntries(
    Object.entries({ RESEND_CHALLENGE_TOKEN: AGENT_TOKEN, ...env }).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
  const cli = childProcess.spawn(process.execPath, [CLI_PATH, ...args], {
    env: cliEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  cli.stdin.end(stdin);

  let stdout = "";
  let stderr = "";
  cli.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  cli.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", resolve);
  });
  return { exitCode, stdout, stderr } satisfies CliResult;
}

/** The command names in the "Commands:" section of a help text; wrapped descriptions indent deeper. */
function listHelpCommands(helpText: string): string[] {
  const commandsSection = helpText.split("Commands:\n")[1]?.split("\n\n")[0] ?? "";
  return commandsSection
    .split("\n")
    .map((line) => /^ {2}(?<name>\S+)/.exec(line)?.groups?.["name"])
    .filter((name) => name !== undefined);
}
