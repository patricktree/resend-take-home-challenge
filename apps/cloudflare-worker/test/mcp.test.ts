import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import { test, type TestContext } from "vitest";

import {
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  unsubmittedDraftSummarySchema,
  type UnsubmittedDraftSummaryResponse,
} from "@resend-challenge/api.routes";

import { TEST_AGENT_TOKEN, TEST_REVIEWER_TOKEN, useWorker, type TestWorker } from "./use-worker.ts";

const LOCAL_MCP_URL = "http://localhost/mcp";
const PRODUCTION_MCP_URL = "https://resend-challenge.patricktree.me/mcp";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Hello",
  body: { plainText: "Hello Ada" },
};

/** A JSON-RPC request for the raw HTTP tests; the authentication answers before the MCP server. */
const LIST_TOOLS_REQUEST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

const MCP_REQUEST_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};

test.for([
  { mode: "legacy", era: "legacy" },
  { mode: "auto", era: "modern" },
] as const)(
  "tools/list ($era protocol era) returns exactly the six Agent tools, with readOnlyHint on the reads",
  async ({ mode, era }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const mcpClient = await connectMcpClient(
      worker,
      { token: LOCAL_AGENT_TOKEN, versionNegotiation: mode },
      { onTestFinished },
    );

    const { tools } = await mcpClient.listTools();

    expect(mcpClient.getProtocolEra()).toBe(era);
    expect(tools.map((tool) => ({ name: tool.name, annotations: tool.annotations }))).toStrictEqual(
      [
        { name: "create_draft", annotations: undefined },
        { name: "get_draft", annotations: { readOnlyHint: true } },
        { name: "list_drafts", annotations: { readOnlyHint: true } },
        { name: "revise_draft", annotations: undefined },
        { name: "submit_draft", annotations: undefined },
        { name: "get_revision", annotations: { readOnlyHint: true } },
      ],
    );
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
  },
);

test("the server instructions describe the lifecycle and link the OpenAPI document", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );

  const instructions = mcpClient.getInstructions();

  expect(instructions).toContain("https://resend-challenge.patricktree.me/api/openapi.json");
  expect(instructions).toContain("show that `reviewUrl` to your user");
  expect(instructions).toContain("Agents cannot approve, reject or send");
  for (const toolName of ["create_draft", "submit_draft", "get_draft", "revise_draft"]) {
    expect(instructions).toContain(toolName);
  }
});

test("the submit_draft description tells the Agent to hand the reviewUrl to its user", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );

  const { tools } = await mcpClient.listTools();
  const submitDraftTool = tools.find((tool) => tool.name === "submit_draft");

  expect(submitDraftTool?.description).toContain("show the Draft's `reviewUrl` to your user");
});

test("create_draft creates a Draft and returns its summary as structured content and as text", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );

  const result = await mcpClient.callTool({ name: "create_draft", arguments: DRAFT_DATA });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({
    id: expect.stringMatching(/^drf_/),
    reviewStatus: "UNSUBMITTED",
    latestRevision: { revisionNumber: 1, to: ["ada@example.com"], subject: "Hello" },
    sending: { status: "NOT_SENT" },
  });
  expect(result.structuredContent).not.toHaveProperty("latestRevision.body");
  expect(result.structuredContent).not.toHaveProperty("reviewUrl");
  expect(result.content).toStrictEqual([
    { type: "text", text: JSON.stringify(result.structuredContent) },
  ]);
  const created = unsubmittedDraftSummarySchema.parse(result.structuredContent);
  const draft = await readThroughApi(worker, `/api/v1/drafts/${created.id}`);
  expect(draft).toMatchObject({ latestRevision: { body: { plainText: "Hello Ada" } } });
});

test("get_draft returns the Draft with its body, as the API does", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  const created = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);

  const result = await mcpClient.callTool({
    name: "get_draft",
    arguments: { draftId: created.id },
  });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toStrictEqual(
    await readThroughApi(worker, `/api/v1/drafts/${created.id}`),
  );
  expect(result.structuredContent).toMatchObject({
    latestRevision: { body: { plainText: "Hello Ada" } },
  });
});

test("list_drafts returns a page of Draft summaries filtered by review status", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);
  const pending = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);
  await callToolSuccessfully(mcpClient, "submit_draft", {
    draftId: pending.id,
    revisionId: pending.latestRevision.id,
  });

  const result = await mcpClient.callTool({
    name: "list_drafts",
    arguments: { reviewStatus: ["PENDING"], limit: 10 },
  });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toStrictEqual(
    await readThroughApi(worker, "/api/v1/drafts?reviewStatus=PENDING&limit=10"),
  );
  expect(result.structuredContent).toMatchObject({
    items: [{ id: pending.id, reviewStatus: "PENDING" }],
  });
});

test("revise_draft creates the next Revision on the latest base", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  const created = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);

  const result = await mcpClient.callTool({
    name: "revise_draft",
    arguments: {
      draftId: created.id,
      baseRevisionId: created.latestRevision.id,
      ...DRAFT_DATA,
      subject: "Hello again",
    },
  });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({
    id: created.id,
    reviewStatus: "UNSUBMITTED",
    latestRevision: { revisionNumber: 2, subject: "Hello again", reviewStatus: "UNSUBMITTED" },
  });
});

test("submit_draft submits the given Revision, and the Draft becomes PENDING", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  const created = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);

  const result = await mcpClient.callTool({
    name: "submit_draft",
    arguments: { draftId: created.id, revisionId: created.latestRevision.id },
  });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({
    id: created.id,
    reviewStatus: "PENDING",
    latestRevision: { id: created.latestRevision.id, reviewStatus: "PENDING" },
    sending: { status: "NOT_SENT" },
  });
});

test("get_revision returns a Superseded Revision with its body", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  const created = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);
  await callToolSuccessfully(mcpClient, "revise_draft", {
    draftId: created.id,
    baseRevisionId: created.latestRevision.id,
    ...DRAFT_DATA,
  });

  const result = await mcpClient.callTool({
    name: "get_revision",
    arguments: { draftId: created.id, revisionId: created.latestRevision.id },
  });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toStrictEqual({
    ...created.latestRevision,
    reviewStatus: "SUPERSEDED",
    body: { plainText: "Hello Ada" },
  });
});

test("revise_draft on a superseded base is a tool error with REVISION_SUPERSEDED", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  const created = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);
  const revise = { draftId: created.id, baseRevisionId: created.latestRevision.id, ...DRAFT_DATA };
  await callToolSuccessfully(mcpClient, "revise_draft", revise);

  const result = await mcpClient.callTool({ name: "revise_draft", arguments: revise });

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(readTextContent(result))).toStrictEqual({
    error: {
      code: "REVISION_SUPERSEDED",
      message: expect.any(String),
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
  });
  const draft = await readThroughApi(worker, `/api/v1/drafts/${created.id}`);
  expect(draft).toMatchObject({ latestRevision: { revisionNumber: 2 } });
});

test("submit_draft of a Rejected Revision is a tool error with REVISION_ALREADY_DECIDED and the existing verdict", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  const created = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);
  const submission = { draftId: created.id, revisionId: created.latestRevision.id };
  await callToolSuccessfully(mcpClient, "submit_draft", submission);
  // No verdict tool exists, by design: the Reviewer rejects through the API.
  const rejection = await worker.fetch(
    `/api/v1/drafts/${created.id}/revisions/${created.latestRevision.id}/rejection`,
    { method: "POST", headers: { Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` } },
  );
  if (rejection.status !== 200) {
    throw new Error(`The Rejection answered with ${rejection.status}: ${await rejection.text()}`);
  }

  const result = await mcpClient.callTool({ name: "submit_draft", arguments: submission });

  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(JSON.parse(readTextContent(result))).toMatchObject({
    error: { code: "REVISION_ALREADY_DECIDED", existingVerdict: "REJECTED" },
  });
});

test("revise_draft without baseRevisionId is refused by its input schema", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const mcpClient = await connectMcpClient(
    worker,
    { token: LOCAL_AGENT_TOKEN },
    { onTestFinished },
  );
  const created = await callToolSuccessfully(mcpClient, "create_draft", DRAFT_DATA);

  const result = await mcpClient.callTool({
    name: "revise_draft",
    arguments: { draftId: created.id, ...DRAFT_DATA },
  });

  expect(result.isError).toBe(true);
  expect(readTextContent(result)).toMatch(/Input validation error.*baseRevisionId/s);
  const draft = await readThroughApi(worker, `/api/v1/drafts/${created.id}`);
  expect(draft).toMatchObject({ latestRevision: { revisionNumber: 1 } });
});

test("on the production host, the configured Agent token runs a tool call", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker(
    { onTestFinished },
    {
      vars: { LOCAL_DEVELOPMENT: "false" },
      secrets: { REVIEWER_TOKEN: TEST_REVIEWER_TOKEN },
    },
  );
  const mcpClient = await connectMcpClient(
    worker,
    { token: TEST_AGENT_TOKEN, url: PRODUCTION_MCP_URL },
    { onTestFinished },
  );

  const result = await mcpClient.callTool({ name: "create_draft", arguments: DRAFT_DATA });

  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({ reviewStatus: "UNSUBMITTED" });
});

test.for([
  { name: "the local Reviewer token", token: LOCAL_REVIEWER_TOKEN },
  { name: "the configured Reviewer token", token: TEST_REVIEWER_TOKEN },
])("$name on /mcp answers with 403 AGENT_ONLY", async ({ token }, { expect, onTestFinished }) => {
  const worker = await useWorker(
    { onTestFinished },
    { secrets: { REVIEWER_TOKEN: TEST_REVIEWER_TOKEN } },
  );

  const response = await worker.fetch(LOCAL_MCP_URL, {
    method: "POST",
    headers: { ...MCP_REQUEST_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify(LIST_TOOLS_REQUEST),
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "AGENT_ONLY",
      message: "The MCP server accepts only the Agent token.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
});

test.for([
  { name: "without a token", headers: MCP_REQUEST_HEADERS },
  {
    name: "with an unknown token",
    headers: { ...MCP_REQUEST_HEADERS, Authorization: "Bearer agent_unknown-token" },
  },
])(
  "a request $name on /mcp answers with 401 UNAUTHENTICATED",
  async ({ headers }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(LOCAL_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(LIST_TOOLS_REQUEST),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  },
);

test("/mcp is stateless: GET, which would open a session stream, answers with 405", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(LOCAL_MCP_URL, {
    headers: { Accept: "text/event-stream", Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` },
  });

  expect(response.status).toBe(405);
});

type ConnectOptions = {
  token: string;
  url?: string;
  versionNegotiation?: VersionNegotiationMode;
};

/**
 * Connects the official MCP SDK client over Streamable HTTP to the test Worker's `/mcp`, sending
 * the token as a static `Authorization` header like an MCP host does.
 */
async function connectMcpClient(
  worker: TestWorker,
  { token, url = LOCAL_MCP_URL, versionNegotiation = "legacy" }: ConnectOptions,
  { onTestFinished }: Pick<TestContext, "onTestFinished">,
): Promise<Client> {
  const mcpClient = new Client(
    { name: "resend-challenge-tests", version: "1.0.0" },
    { versionNegotiation: { mode: versionNegotiation } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => fetchThroughWorker(worker, new Request(input, init)),
  });
  await mcpClient.connect(transport);
  onTestFinished(() => mcpClient.close());

  return mcpClient;
}

/**
 * Calls a tool that must succeed and answers with a Draft summary, and returns that summary, parsed
 * with the contract's schema.
 */
async function callToolSuccessfully(
  mcpClient: Client,
  name: string,
  toolArguments: Record<string, unknown>,
): Promise<UnsubmittedDraftSummaryResponse> {
  const result = await mcpClient.callTool({ name, arguments: toolArguments });
  if (result.isError === true) {
    throw new Error(`The tool ${name} failed: ${readTextContent(result)}`);
  }
  // Every tool these tests call returns a Draft summary; only submit_draft adds `reviewUrl`.
  return unsubmittedDraftSummarySchema.parse(result.structuredContent);
}

function readTextContent(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Reads an API path over plain HTTP with the local Agent token, the reference for the tools. */
async function readThroughApi(worker: TestWorker, path: string): Promise<unknown> {
  const response = await worker.fetch(path, {
    headers: { Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` },
  });
  if (response.status !== 200) {
    throw new Error(`GET ${path} answered with ${response.status}.`);
  }
  return response.json();
}

/**
 * Sends a request to the test Worker. The test runtime speaks Miniflare's fetch types, the MCP
 * client the runtime's own, so the request and the response are copied across.
 */
async function fetchThroughWorker(worker: TestWorker, request: Request): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await worker.fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body: hasBody ? await request.text() : null,
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: [...response.headers],
  });
}
