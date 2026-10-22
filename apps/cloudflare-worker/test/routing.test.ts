import { test } from "vitest";

import { LOCAL_AGENT_TOKEN } from "@resend-challenge/api.routes";

import { TEST_AGENT_TOKEN, TEST_REVIEWER_TOKEN, useWorker } from "./use-worker.ts";

const AUTHORIZATION = { Authorization: `Bearer ${LOCAL_AGENT_TOKEN}` };

/** An absolute URL, so that the quickstart's links have a known origin. */
const ROOT_URL = "http://localhost/";

/** What a browser sends when it navigates to a page. */
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

test.for([BROWSER_ACCEPT, "text/markdown;q=0, text/html"])(
  "the root redirects a browser (Accept: %s) to the Review UI",
  async (accept, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(ROOT_URL, {
      headers: { Accept: accept },
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/app/");
    expect(response.headers.get("Vary")).toBe("Accept");
  },
);

test.for([
  { description: "text/markdown", accept: "text/markdown" },
  { description: "text/markdown before text/html", accept: "text/markdown, text/html;q=0.9" },
  { description: "text/markdown after text/html", accept: "text/html, text/markdown" },
  { description: "*/*", accept: "*/*" },
  { description: "application/json", accept: "application/json" },
  { description: "no", accept: undefined },
])(
  "the root answers $description Accept with the agent quickstart as Markdown",
  async ({ accept }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(ROOT_URL, {
      headers: accept === undefined ? {} : { Accept: accept },
      redirect: "manual",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(await response.text()).toMatch(/^# Email Draft Approval/);
  },
);

test("/llms.txt serves the agent quickstart as plain text to any client, without authentication", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const llmsTxtResponse = await worker.fetch("http://localhost/llms.txt", {
    headers: { Accept: BROWSER_ACCEPT },
  });
  const rootResponse = await worker.fetch(ROOT_URL);

  expect(llmsTxtResponse.status).toBe(200);
  expect(llmsTxtResponse.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(await llmsTxtResponse.text()).toBe(await rootResponse.text());
});

test("the agent quickstart links the MCP server, the OpenAPI document and the Agent Skill", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("http://127.0.0.1/");
  const quickstart = await response.text();

  expect(quickstart).toContain("http://127.0.0.1/mcp");
  expect(quickstart).toContain("claude mcp add --transport http");
  expect(quickstart).toContain("http://127.0.0.1/api/openapi.json");
  expect(quickstart).toContain(
    "https://github.com/patricktree/resend-take-home-challenge/tree/main/skills/email-draft-approval",
  );
  expect(quickstart).toContain("npx skills add patricktree/resend-take-home-challenge");
  expect(quickstart).toContain("`reviewUrl`");
  expect(quickstart).not.toContain("https://resend-challenge.patricktree.me");
});

test.for([
  {
    name: "the local Agent token in local development on a local host",
    origin: "http://localhost",
    isLocalDevelopment: true,
    expectedToken: LOCAL_AGENT_TOKEN,
  },
  {
    name: "the configured Agent token in local development on a non-local host",
    origin: "https://resend-challenge.patricktree.me",
    isLocalDevelopment: true,
    expectedToken: TEST_AGENT_TOKEN,
  },
  {
    name: "the configured Agent token outside local development",
    origin: "http://localhost",
    isLocalDevelopment: false,
    expectedToken: TEST_AGENT_TOKEN,
  },
])(
  "the agent quickstart shows $name, which the API accepts",
  async ({ origin, isLocalDevelopment, expectedToken }, { expect, onTestFinished }) => {
    const worker = await useWorker(
      { onTestFinished },
      isLocalDevelopment
        ? {}
        : {
            vars: { LOCAL_DEVELOPMENT: "false" },
            secrets: { REVIEWER_TOKEN: TEST_REVIEWER_TOKEN },
          },
    );

    const quickstart = await (await worker.fetch(`${origin}/`)).text();
    const shownTokens = new Set(
      [...quickstart.matchAll(/Authorization: Bearer ([\w-]+)/g)].map((match) => match[1]),
    );
    const createResponse = await worker.fetch(`${origin}/api/v1/drafts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${expectedToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: ["delivered@resend.dev"],
        subject: "Hello",
        body: { plainText: "Hello from the quickstart." },
      }),
    });

    expect(shownTokens).toStrictEqual(new Set([expectedToken]));
    expect(createResponse.status).toBe(201);
  },
);

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
