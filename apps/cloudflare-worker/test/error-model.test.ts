import { test } from "vitest";

import { LOCAL_AGENT_TOKEN } from "@resend-challenge/api.routes";

import { TEST_AGENT_TOKEN, useWorker } from "#test/use-worker.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.for([
  { name: "a redirect", path: "/", headers: {}, status: 302 },
  { name: "the OpenAPI document", path: "/api/openapi.json", headers: {}, status: 200 },
  { name: "a refused request", path: "/api/v1/drafts", headers: {}, status: 401 },
  {
    name: "an unknown API path",
    path: "/api/v1/unknown",
    headers: { Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` },
    status: 404,
  },
])(
  "$name carries a per-request X-Request-Id",
  async ({ path, headers, status }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const first = await worker.fetch(path, { headers, redirect: "manual" });
    const second = await worker.fetch(path, { headers, redirect: "manual" });

    expect(first.status).toBe(status);
    expect(first.headers.get("X-Request-Id")).toMatch(UUID_PATTERN);
    expect(second.headers.get("X-Request-Id")).toMatch(UUID_PATTERN);
    expect(first.headers.get("X-Request-Id")).not.toBe(second.headers.get("X-Request-Id"));
  },
);

test("an unhandled error answers with 500 INTERNAL_ERROR and a generic message", async ({
  expect,
  onTestFinished,
}) => {
  // Outside local development REVIEWER_TOKEN is required; authenticating without it throws.
  const worker = await useWorker({ onTestFinished }, { vars: { LOCAL_DEVELOPMENT: "false" } });

  const response = await worker.fetch("https://resend-challenge.patricktree.me/api/v1/drafts", {
    headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` },
  });

  expect(response.status).toBe(500);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "INTERNAL_ERROR",
      message: "An internal error occurred.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
  expect(response.headers.get("X-Request-Id")).toMatch(UUID_PATTERN);
});
