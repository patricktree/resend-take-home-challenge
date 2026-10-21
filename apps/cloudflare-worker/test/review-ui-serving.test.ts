import fs from "node:fs/promises";
import { test } from "vitest";

import { useWorker } from "./use-worker.ts";

/** The test runtime's stand-in for the built Review UI (wrangler.test.jsonc, `assets`). */
const FIXTURE_INDEX_HTML = await fs.readFile(
  new URL("assets/app/index.html", import.meta.url),
  "utf8",
);

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

test("the Review UI's index.html is served at /app/", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/app/");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  expect(await response.text()).toBe(FIXTURE_INDEX_HTML);
});

test("a file of the Review UI is served at its own path", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/app/assets/fixture.css");

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toMatch(/^text\/css/);
  expect(await response.text()).toContain("#root");
});

test.for(["/app", "/app/decided", "/app/drafts/drf_unknown", "/app/assets/missing.css"])(
  "the path %s, which has no file, falls back to index.html with 200",
  async (path, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(path);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await response.text()).toBe(FIXTURE_INDEX_HTML);
  },
);

test.for(["/app/", "/app/assets/fixture.css", "/app/drafts/drf_unknown"])(
  "the response to %s carries the security headers",
  async (path, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(path);

    expect(Object.fromEntries(response.headers)).toMatchObject(SECURITY_HEADERS);
  },
);

test("the Review UI's files are public: no token is needed", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/app/drafts/drf_unknown", {
    headers: { Authorization: "Bearer agent_not-a-configured-token" },
  });

  expect(response.status).toBe(200);
});
