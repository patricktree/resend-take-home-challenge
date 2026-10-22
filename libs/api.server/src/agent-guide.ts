import type { Context, Hono } from "hono";

import { LOCAL_AGENT_TOKEN, OPENAPI_DOCUMENT_PATH } from "@resend-challenge/api.routes";
import { describeLifecycle } from "@resend-challenge/mcp-server";

import AGENT_SKILL from "../../../skills/email-draft-approval/SKILL.md";
import type { ApiServerHonoEnvironment } from "./api-server-environment.ts";
import { acceptsLocalTokens } from "./authentication.ts";
import { MCP_PATH } from "./mcp-endpoint.ts";

/** Where the Worker serves the Agent Skill of `skills/email-draft-approval/SKILL.md`. */
const AGENT_SKILL_PATH = "/skills/email-draft-approval/SKILL.md";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/**
 * Serves what an Agent needs that was given nothing but the Worker's URL: the agent quickstart at
 * `/` (unless a browser asks for HTML, which goes to the Review UI) and at `/llms.txt`, and the
 * Agent Skill. All three are public and never reach D1.
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

  app.get(AGENT_SKILL_PATH, (context) =>
    context.body(AGENT_SKILL, 200, { "Content-Type": MARKDOWN_CONTENT_TYPE }),
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
 * to itself. The token is the local Agent token wherever the Worker accepts it, and the configured
 * Agent token otherwise, read per request, so rotating it (`pnpm secrets:generate`) needs no change
 * here.
 */
function describeQuickstart(context: Context<ApiServerHonoEnvironment>): string {
  const origin = new URL(context.req.url).origin;
  const agentToken = acceptsLocalTokens(context.env, context.req.url)
    ? LOCAL_AGENT_TOKEN
    : context.env.AGENT_TOKEN;
  const mcpUrl = `${origin}${MCP_PATH}`;
  const agentSkillUrl = `${origin}${AGENT_SKILL_PATH}`;

  return [
    "# Email Draft Approval",
    "",
    "Human approval for emails written by Agents. You, an Agent, compose an email Draft and submit its latest Revision for review; a human Reviewer approves or rejects exactly that Revision. Only an approved Revision is sent, through Resend, at most once.",
    "",
    "## Authenticate",
    "",
    "Send the public Agent token on every request. It is public by design: it creates, revises and submits Drafts, and it can never approve or send.",
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
    `The Agent Skill at ${agentSkillUrl} covers the whole workflow, polling and the error codes that need a specific reaction. Install it for Claude Code:`,
    "",
    "```sh",
    `mkdir -p ~/.claude/skills/email-draft-approval && curl -sSo ~/.claude/skills/email-draft-approval/SKILL.md ${agentSkillUrl}`,
    "```",
    "",
  ].join("\n");
}
