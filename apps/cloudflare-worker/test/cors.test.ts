import { test } from "vitest";

import { LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN } from "@resend-challenge/api.routes";

import { TEST_AGENT_TOKEN, useWorker } from "./use-worker.ts";

const LOCAL_MCP_URL = "http://localhost/mcp";

/** A web page on another site, such as a web-based MCP host. */
const FOREIGN_ORIGIN = "https://mcp-host.example";

const LIST_TOOLS_REQUEST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

const MCP_REQUEST_HEADERS = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  Origin: FOREIGN_ORIGIN,
};

/**
 * Every CORS header of a preflight answer of `/mcp`: neither `Access-Control-Allow-Credentials` nor
 * `Access-Control-Allow-Private-Network`.
 */
const MCP_PREFLIGHT_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID",
  "access-control-max-age": "600",
};

/** Every CORS header of any other response of `/mcp`. */
const MCP_RESPONSE_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers":
    "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate, X-Request-Id",
};

test("a preflight of /mcp answers with 204 and the CORS headers, without a token", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(LOCAL_MCP_URL, {
    method: "OPTIONS",
    headers: {
      Origin: FOREIGN_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version",
    },
  });

  expect(response.status).toBe(204);
  expect(readCorsHeaders(response)).toStrictEqual(MCP_PREFLIGHT_CORS_HEADERS);
  expect(await response.text()).toBe("");
});

test("a preflight of /mcp that asks for private network access is not granted it", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(LOCAL_MCP_URL, {
    method: "OPTIONS",
    headers: {
      Origin: FOREIGN_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
      "Access-Control-Request-Private-Network": "true",
    },
  });

  expect(response.status).toBe(204);
  expect(readCorsHeaders(response)).toStrictEqual(MCP_PREFLIGHT_CORS_HEADERS);
});

test("tools/list from a web page on another site with the Agent token carries the CORS headers", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(LOCAL_MCP_URL, {
    method: "POST",
    headers: { ...MCP_REQUEST_HEADERS, Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` },
    body: JSON.stringify(LIST_TOOLS_REQUEST),
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain('"name":"create_draft"');
  expect(readCorsHeaders(response)).toStrictEqual(MCP_RESPONSE_CORS_HEADERS);
});

test.for([
  { name: "without a token", authorization: undefined, status: 401, code: "UNAUTHENTICATED" },
  {
    name: "with an unknown token",
    authorization: "Bearer agent_unknown-token",
    status: 401,
    code: "UNAUTHENTICATED",
  },
  {
    name: "with the Reviewer token",
    authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}`,
    status: 403,
    code: "AGENT_ONLY",
  },
])(
  "a refused request $name on /mcp carries the CORS headers",
  async ({ authorization, status, code }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(LOCAL_MCP_URL, {
      method: "POST",
      headers: {
        ...MCP_REQUEST_HEADERS,
        ...(authorization === undefined ? {} : { Authorization: authorization }),
      },
      body: JSON.stringify(LIST_TOOLS_REQUEST),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(readCorsHeaders(response)).toStrictEqual(MCP_RESPONSE_CORS_HEADERS);
  },
);

test("a GET of /mcp, which the stateless server refuses with 405, carries the CORS headers", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(LOCAL_MCP_URL, {
    headers: {
      Accept: "text/event-stream",
      Origin: FOREIGN_ORIGIN,
      Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
    },
  });

  expect(response.status).toBe(405);
  expect(readCorsHeaders(response)).toStrictEqual(MCP_RESPONSE_CORS_HEADERS);
});

test("an internal error on /mcp carries the CORS headers", async ({ expect, onTestFinished }) => {
  // Outside local development REVIEWER_TOKEN is required; authenticating without it throws.
  const worker = await useWorker({ onTestFinished }, { vars: { LOCAL_DEVELOPMENT: "false" } });

  const response = await worker.fetch("https://resend-challenge.patricktree.me/mcp", {
    method: "POST",
    headers: { ...MCP_REQUEST_HEADERS, Authorization: `Bearer ${TEST_AGENT_TOKEN}` },
    body: JSON.stringify(LIST_TOOLS_REQUEST),
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  expect(readCorsHeaders(response)).toStrictEqual(MCP_RESPONSE_CORS_HEADERS);
});

test.for([
  {
    name: "a GET of an API route",
    path: "/api/v1/drafts",
    method: "GET",
    headers: { Origin: FOREIGN_ORIGIN, Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` },
    status: 200,
  },
  {
    name: "a preflight of an API route",
    path: "/api/v1/drafts",
    method: "OPTIONS",
    headers: {
      Origin: FOREIGN_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
    status: 401,
  },
  {
    name: "the Review UI",
    path: "/app/",
    method: "GET",
    headers: { Origin: FOREIGN_ORIGIN },
    status: 200,
  },
])(
  "$name carries no CORS headers",
  async ({ path, method, headers, status }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(path, { method, headers });

    expect(response.status).toBe(status);
    expect(readCorsHeaders(response)).toStrictEqual({});
  },
);

/** Returns every `Access-Control-*` header of a response, with lowercase names. */
function readCorsHeaders(response: {
  headers: Iterable<[string, string]>;
}): Record<string, string> {
  return Object.fromEntries(
    [...response.headers].filter(([name]) => name.toLowerCase().startsWith("access-control-")),
  );
}
