import { test } from "vitest";

import { LOCAL_AGENT_TOKEN } from "@resend-challenge/api.routes";

import { useWorker } from "#test/use-worker.ts";

const AUTHORIZATION = { Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` };

test("the root redirects to the Review UI", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/", { redirect: "manual" });

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/app/");
});

test("an unknown API path answers with a JSON 404 NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/unknown", { headers: AUTHORIZATION });

  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "NOT_FOUND",
      message: "No route matches this path.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
});

test.for(["/unknown", "/apis", "/favicon.ico"])(
  "the non-API path %s answers with a JSON 404 NOT_FOUND",
  async (path, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(path);

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message: "No route matches this path.",
        requestId: response.headers.get("X-Request-Id"),
      },
    });
  },
);

test("the Worker exports a scheduled handler", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const result = await worker.scheduled({ cron: "* * * * *" });

  expect(result.outcome).toBe("ok");
});
