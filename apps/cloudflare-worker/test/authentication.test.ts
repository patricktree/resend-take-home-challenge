import { test } from "vitest";

import { LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN } from "@resend-challenge/api.routes";

import { TEST_AGENT_TOKEN, TEST_REVIEWER_TOKEN, useWorker } from "./use-worker.ts";

// An authenticated request reaches the 404 DRAFT_NOT_FOUND of this unknown Draft, while a refused
// one stops at the 401.
const PROTECTED_PATH = "/api/v1/drafts/drf_00000000-0000-7000-8000-000000000000";
const PRODUCTION_URL = `https://resend-challenge.patricktree.me${PROTECTED_PATH}`;

test("a request without a token answers with 401 UNAUTHENTICATED", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(PROTECTED_PATH);

  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  expect(await response.json()).toStrictEqual({
    error: {
      code: "UNAUTHENTICATED",
      message: "A valid bearer token is required.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
});

test.for([
  { name: "an unknown token", authorization: "Bearer agent_unknown-token" },
  { name: "an empty token", authorization: "Bearer " },
  { name: "another scheme", authorization: `Basic ${TEST_AGENT_TOKEN}` },
  { name: "a bare token", authorization: TEST_AGENT_TOKEN },
])(
  "a request with $name answers with 401 UNAUTHENTICATED",
  async ({ authorization }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(PROTECTED_PATH, {
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(body).not.toContain("unknown-token");
    expect(body).not.toContain(TEST_AGENT_TOKEN);
  },
);

test("the configured Agent token is accepted on the production host", async ({
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

  const response = await worker.fetch(PRODUCTION_URL, {
    headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` },
  });

  expect(response.status).toBe(404);
});

test("the configured Reviewer token is accepted on the production host", async ({
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

  const response = await worker.fetch(PRODUCTION_URL, {
    headers: { Authorization: `Bearer ${TEST_REVIEWER_TOKEN}` },
  });

  expect(response.status).toBe(404);
});

test("the bearer scheme is case-insensitive", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch(PROTECTED_PATH, {
    headers: { Authorization: `bearer ${TEST_AGENT_TOKEN}` },
  });

  expect(response.status).toBe(404);
});

test.for([
  { host: "localhost", token: LOCAL_AGENT_TOKEN, role: "Agent" },
  { host: "127.0.0.1", token: LOCAL_AGENT_TOKEN, role: "Agent" },
  { host: "[::1]", token: LOCAL_AGENT_TOKEN, role: "Agent" },
  { host: "host.docker.internal", token: LOCAL_AGENT_TOKEN, role: "Agent" },
  { host: "localhost", token: LOCAL_REVIEWER_TOKEN, role: "Reviewer" },
])(
  "local development accepts the local $role token on $host without REVIEWER_TOKEN",
  async ({ host, token }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(`http://${host}:8787${PROTECTED_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
  },
);

test.for([LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN])(
  "local development accepts the local token %s without AGENT_TOKEN",
  async (token, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished }, { secrets: { AGENT_TOKEN: undefined } });

    const response = await worker.fetch(`http://localhost:8787${PROTECTED_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
  },
);

test("outside local development a Worker without AGENT_TOKEN refuses to authenticate", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker(
    { onTestFinished },
    {
      vars: { LOCAL_DEVELOPMENT: "false" },
      secrets: { AGENT_TOKEN: undefined, REVIEWER_TOKEN: TEST_REVIEWER_TOKEN },
    },
  );

  const response = await worker.fetch(PRODUCTION_URL, {
    headers: { Authorization: `Bearer ${TEST_REVIEWER_TOKEN}` },
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
});

test.for([LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN])(
  "the local token %s is refused without LOCAL_DEVELOPMENT",
  async (token, { expect, onTestFinished }) => {
    const worker = await useWorker(
      { onTestFinished },
      {
        vars: { LOCAL_DEVELOPMENT: "false" },
        secrets: { REVIEWER_TOKEN: TEST_REVIEWER_TOKEN },
      },
    );

    const response = await worker.fetch(`http://localhost:8787${PROTECTED_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  },
);

test.for([LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN])(
  "the local token %s is refused on a non-local host even with LOCAL_DEVELOPMENT",
  async (token, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(PRODUCTION_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  },
);

test("the OpenAPI document is public", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/openapi.json");

  expect(response.status).toBe(200);
});

test("only GET of the OpenAPI document is public", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/openapi.json", { method: "POST" });

  expect(response.status).toBe(401);
});

test("a Worker whose Agent and Reviewer tokens are equal refuses to authenticate", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker(
    { onTestFinished },
    { vars: { LOCAL_DEVELOPMENT: "false" }, secrets: { REVIEWER_TOKEN: TEST_AGENT_TOKEN } },
  );

  const response = await worker.fetch(PRODUCTION_URL, {
    headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` },
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
});
