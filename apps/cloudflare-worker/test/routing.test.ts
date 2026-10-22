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

test("the agent quickstart links the MCP server for Claude Code and Codex, the OpenAPI document and the Agent Skill", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("http://127.0.0.1/");
  const quickstart = await response.text();

  expect(quickstart).toContain("http://127.0.0.1/mcp");
  expect(quickstart).toContain("claude mcp add --transport http");
  expect(quickstart).toContain(
    "codex mcp add resend-challenge --url http://127.0.0.1/mcp --bearer-token-env-var RESEND_CHALLENGE_TOKEN",
  );
  expect(quickstart).toContain("~/.agents/skills/email-draft-approval/SKILL.md");
  expect(quickstart).toContain("http://127.0.0.1/api/openapi.json");
  expect(quickstart).toContain(
    "https://github.com/patricktree/resend-take-home-challenge/tree/main/skills/email-draft-approval",
  );
  expect(quickstart).toContain("npx skills add patricktree/resend-take-home-challenge");
  expect(quickstart).toContain("`reviewUrl`");
  expect(quickstart).not.toContain("https://resend-challenge.patricktree.me");
});

test("the agent quickstart shows the local Agent token in local development on a local host, which the API accepts", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const quickstart = await (await worker.fetch(ROOT_URL)).text();
  const createResponse = await worker.fetch("http://localhost/api/v1/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: ["delivered@resend.dev"],
      subject: "Hello",
      body: { plainText: "Hello from the quickstart." },
    }),
  });

  expect(findShownTokens(quickstart)).toStrictEqual(new Set([LOCAL_AGENT_TOKEN]));
  expect(quickstart).not.toContain(TEST_AGENT_TOKEN);
  expect(createResponse.status).toBe(201);
});

test.for([
  {
    name: "in local development on a non-local host",
    origin: "https://resend-challenge.patricktree.me",
    isLocalDevelopment: true,
  },
  { name: "outside local development", origin: "http://localhost", isLocalDevelopment: false },
])(
  "the agent quickstart never shows the configured Agent token $name, only a placeholder",
  async ({ origin, isLocalDevelopment }, { expect, onTestFinished }) => {
    const worker = await useWorker(
      { onTestFinished },
      isLocalDevelopment
        ? {}
        : {
            vars: { LOCAL_DEVELOPMENT: "false" },
            secrets: { REVIEWER_TOKEN: TEST_REVIEWER_TOKEN },
          },
    );

    const quickstart = await (await worker.fetch(`${origin}/llms.txt`)).text();

    expect(findShownTokens(quickstart)).toStrictEqual(new Set(["<agent-token>"]));
    expect(quickstart).toContain("The repository owner hands out the Agent token");
    expect(quickstart).not.toContain(TEST_AGENT_TOKEN);
    expect(quickstart).not.toContain(LOCAL_AGENT_TOKEN);
  },
);

test("the agent quickstart works when local development configures no Agent token", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished }, { secrets: { AGENT_TOKEN: undefined } });

  const response = await worker.fetch("https://resend-challenge.patricktree.me/");

  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("undefined");
});

/** The tokens of every `Authorization: Bearer …` the quickstart shows. */
function findShownTokens(quickstart: string): Set<string | undefined> {
  return new Set(
    [...quickstart.matchAll(/Authorization: Bearer ([\w<>-]+)/g)].map((match) => match[1]),
  );
}

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
