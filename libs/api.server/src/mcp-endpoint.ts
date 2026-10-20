import { createMcpHandler } from "agents/mcp/server";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { DraftApprovalClient } from "@draft-approval/api.client";
import { ERROR_CODE } from "@draft-approval/api.routes";
import { createDraftApprovalMcpServer } from "@draft-approval/mcp-server";

import type { ApiServerHonoEnvironment } from "#src/api-server-environment.ts";
import { parseBearerToken, ROLE } from "#src/authentication.ts";
import { jsonError } from "#src/http-errors.ts";

/** The path of the MCP server, Streamable HTTP. */
export const MCP_PATH = "/mcp";

/**
 * Lets only the Agent role through to the MCP server: the Reviewer token gets 403, so it is useless
 * when configured into an Agent host. Runs after `authenticate`, which has set the role.
 */
export const requireAgent = createMiddleware<ApiServerHonoEnvironment>(async (context, next) => {
  if (context.get("role") !== ROLE.AGENT) {
    return jsonError(
      context,
      403,
      ERROR_CODE.AGENT_ONLY,
      "The MCP server accepts only the Agent token.",
    );
  }

  return next();
});

/**
 * Creates the handler of {@link MCP_PATH}: a stateless MCP server whose tools call the API through
 * the typed client. The client's `fetch` calls `app` in-process and its token is the caller's own,
 * so every tool call passes the same authentication, authorization and validation as an HTTP call;
 * the MCP server has no credential of its own and never fetches the Worker's public hostname.
 */
export function createMcpEndpoint(app: Hono<ApiServerHonoEnvironment>) {
  return async (context: Context<ApiServerHonoEnvironment>): Promise<Response> => {
    const callerToken = parseBearerToken(context.req.header("Authorization"));
    if (callerToken === undefined) {
      throw new Error(
        "The MCP endpoint was reached without a bearer token; run `authenticate` first.",
      );
    }

    // One client per HTTP request, which is one MCP call: no read bookmark is kept between calls.
    const client = new DraftApprovalClient({
      // The request's own origin, so the local-development rule sees the same host as the caller's.
      baseUrl: new URL(context.req.url).origin,
      token: callerToken,
      fetch: async (request) => app.fetch(request, context.env, context.executionCtx),
    });
    const handleMcpRequest = createMcpHandler(
      () => createDraftApprovalMcpServer({ client, publicBaseUrl: context.env.PUBLIC_BASE_URL }),
      // The Worker sends no CORS headers anywhere (spec section 7, "Browser hardening").
      { route: MCP_PATH, corsOptions: false },
    );

    // The handler's `fetch` face: the Worker-shaped call would only read OAuth props from the
    // execution context, and `/mcp` has no OAuth.
    return handleMcpRequest.fetch(context.req.raw);
  };
}
