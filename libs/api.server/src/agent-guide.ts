import type { Context, Hono } from "hono";

import { LOCAL_AGENT_TOKEN, OPENAPI_DOCUMENT_PATH } from "@resend-challenge/api.routes";
import { describeLifecycle } from "@resend-challenge/mcp-server";

import type { ApiServerHonoEnvironment } from "./api-server-environment.ts";
import { acceptsLocalTokens } from "./authentication.ts";
import { MCP_PATH } from "./mcp-endpoint.ts";

/**
 * The Agent Skill `skills/email-draft-approval/SKILL.md`, distributed through the public
 * repository.
 */
const AGENT_SKILL_URL =
  "https://github.com/patricktree/resend-take-home-challenge/tree/main/skills/email-draft-approval";

const AGENT_SKILL_RAW_URL =
  "https://raw.githubusercontent.com/patricktree/resend-take-home-challenge/main/skills/email-draft-approval/SKILL.md";

/** Stands in for the configured Agent token, which the quickstart never shows. */
const AGENT_TOKEN_PLACEHOLDER = "<agent-token>";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/**
 * Serves what an Agent needs that was given nothing but the Worker's URL: the agent quickstart at
 * `/` (unless a browser asks for HTML, which goes to the Review UI) and at `/llms.txt`. Both are
 * public and never reach D1.
 */
export function mountAgentGuide(app: Hono<ApiServerHonoEnvironment>): void {
  app.get("/", (context) => {
    // The answer depends on `Accept`, so caches must keep the redirect and the Markdown apart.
    context.header("Vary", "Accept");
    if (isAskingForHtml(context.req.header("Accept"))) {
      return context.redirect("/app/", 302);
    }

    return context.body(describeQuickstart(context), 200, {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
    });
  });

  // The llms.txt convention serves Markdown as plain text, to every client alike.
  app.get("/llms.txt", (context) =>
    context.body(describeQuickstart(context), 200, {
      "Content-Type": "text/plain; charset=utf-8",
    }),
  );
}

/**
 * Whether the client prefers HTML: it accepts `text/html` and does not accept `text/markdown`, so a
 * wildcard and a missing header get Markdown. A media range with `q=0` counts as not accepted;
 * other q-values do not rank the two.
 */
function isAskingForHtml(acceptHeader: string | undefined): boolean {
  if (acceptHeader === undefined) {
    return false;
  }

  const acceptedMediaTypes = new Set(
    acceptHeader
      .split(",")
      .map((mediaRange) => mediaRange.split(";").map((part) => part.trim().toLowerCase()))
      .filter(
        ([, ...parameters]) => !parameters.some((parameter) => /^q=0(\.0*)?$/.test(parameter)),
      )
      .map(([mediaType]) => mediaType),
  );
  return acceptedMediaTypes.has("text/html") && !acceptedMediaTypes.has("text/markdown");
}

/**
 * The agent quickstart, in Markdown. Its URLs use the request's origin, so local development links
 * to itself. It never shows the configured Agent token, a secret the repository owner hands out:
 * only the local Agent token, wherever the Worker accepts it, and a placeholder everywhere else.
 */
function describeQuickstart(context: Context<ApiServerHonoEnvironment>): string {
  const origin = new URL(context.req.url).origin;
  const isAcceptingLocalTokens = acceptsLocalTokens(context.env, context.req.url);
  const agentToken = isAcceptingLocalTokens ? LOCAL_AGENT_TOKEN : AGENT_TOKEN_PLACEHOLDER;
  const mcpUrl = `${origin}${MCP_PATH}`;

  return [
    "# Email Draft Approval",
    "",
    "Human approval for emails written by Agents. You, an Agent, compose an email Draft and submit its latest Revision for review; a human Reviewer approves or rejects exactly that Revision. Only an approved Revision is sent, through Resend, at most once.",
    "",
    "## Authenticate",
    "",
    "Send the Agent token on every request. It creates, revises and submits Drafts, and it can never approve or send.",
    "",
    isAcceptingLocalTokens
      ? "This Worker runs in local development, so it accepts the local Agent token shown below."
      : `The repository owner hands out the Agent token; replace \`${AGENT_TOKEN_PLACEHOLDER}\` below with it. Ask your user for it if you do not have it.`,
    "",
    "```text",
    `Authorization: Bearer ${agentToken}`,
    "```",
    "",
    "## Connect",
    "",
    `Prefer the MCP server: Streamable HTTP at ${mcpUrl}, with the token as a static \`Authorization\` header and no OAuth. For Claude Code:`,
    "",
    "```sh",
    `claude mcp add --transport http resend-challenge ${mcpUrl} --header 'Authorization: Bearer ${agentToken}'`,
    "```",
    "",
    `Without MCP, call the HTTP API under ${origin}/api/v1 with the same header. Its OpenAPI document: ${origin}${OPENAPI_DOCUMENT_PATH}`,
    "",
    "## Lifecycle",
    "",
    ...describeLifecycle({ shouldNameHttpOperations: true }),
    "",
    "Say the email was sent only once `sending.status` is SENT.",
    "",
    "## Agent Skill",
    "",
    `The Agent Skill at ${AGENT_SKILL_URL} covers the whole workflow, polling and the error codes that need a specific reaction. Install it with the skills CLI, or for Claude Code by hand:`,
    "",
    "```sh",
    "npx skills add patricktree/resend-take-home-challenge",
    `mkdir -p ~/.claude/skills/email-draft-approval && curl -sSo ~/.claude/skills/email-draft-approval/SKILL.md ${AGENT_SKILL_RAW_URL}`,
    "```",
    "",
  ].join("\n");
}
