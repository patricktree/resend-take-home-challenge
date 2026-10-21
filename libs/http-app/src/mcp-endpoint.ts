import { createMcpHandler } from "agents/mcp/server";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { ERROR_CODE } from "@resend-challenge/api.routes";
import { ApiClient, createResendChallengeMcpServer } from "@resend-challenge/mcp-server";

import { parseBearerToken, ROLE } from "./authentication.ts";
import type { HttpAppHonoEnvironment } from "./http-app-environment.ts";
import { jsonError } from "./http-errors.ts";

/** The path of the MCP server, Streamable HTTP. */
export const MCP_PATH = "/mcp";

/**
 * The CORS headers of a preflight of `/mcp`, which lets MCP clients in a web page call it (spec
 * section 7, "Browser hardening"). The origin is a wildcard and credentials are never allowed: only
 * the bearer token authenticates, and a page has to hold it already.
 */
const MCP_PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  // The methods of the Streamable HTTP transport.
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  // The request headers the MCP SDK client sends; it sends `Mcp-Param-*` only for tools that
  // declare `x-mcp-header`, which none of ours does.
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID",
  // Short, so that a change of these headers reaches browsers within minutes.
  "Access-Control-Max-Age": "600",
};

/** The CORS headers of every other response of `/mcp`. */
const MCP_RESPONSE_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate, X-Request-Id",
};

/**
 * Answers the CORS preflight (`OPTIONS`) of {@link MCP_PATH} with 204. It is mounted before
 * authentication, since a browser sends no credentials on a preflight. It never answers a Private
 * Network Access preflight with `Access-Control-Allow-Private-Network`, so browsers that enforce it
 * keep public sites from reaching a developer's local `/mcp`.
 */
export function answerMcpPreflight(context: Context<HttpAppHonoEnvironment>): Response {
  return context.body(null, 204, MCP_PREFLIGHT_HEADERS);
}

/**
 * Adds the CORS headers to every non-preflight response of {@link MCP_PATH}, errors included, so a
 * browser client can read them. Runs before authentication, so it also covers its 401 and 403.
 */
export const addMcpCorsHeaders = createMiddleware<HttpAppHonoEnvironment>(
  async (context, next) => {
    await next();
    for (const [name, value] of Object.entries(MCP_RESPONSE_CORS_HEADERS)) {
      context.header(name, value);
    }
  },
);

/**
 * Lets only the Agent role through to the MCP server: the Reviewer token gets 403, so it is useless
 * when configured into an Agent host. Runs after `authenticate`, which has set the role.
 */
export const requireAgent = createMiddleware<HttpAppHonoEnvironment>(async (context, next) => {
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
export function createMcpEndpoint(
  app: Hono<HttpAppHonoEnvironment>,
): (context: Context<HttpAppHonoEnvironment>) => Promise<Response> {
  return async (context: Context<HttpAppHonoEnvironment>): Promise<Response> => {
    const callerToken = parseBearerToken(context.req.header("Authorization"));
    if (callerToken === undefined) {
      throw new Error(
        "The MCP endpoint was reached without a bearer token; run `authenticate` first.",
      );
    }

    // One client per HTTP request, which is one MCP call: no read bookmark is kept between calls.
    const client = new ApiClient({
      // The request's own origin, so the local-development rule sees the same host as the caller's.
      baseUrl: new URL(context.req.url).origin,
      token: callerToken,
      fetch: async (request) => app.fetch(request, context.env, context.executionCtx),
    });
    const handleMcpRequest = createMcpHandler(
      () => createResendChallengeMcpServer({ client, publicBaseUrl: context.env.PUBLIC_BASE_URL }),
      {
        route: MCP_PATH,
        // `answerMcpPreflight` and `addMcpCorsHeaders` set the CORS headers; `false` keeps the
        // handler from adding its own.
        corsOptions: false,
        // Web pages on any site may call `/mcp` (`addMcpCorsHeaders`), so their `Origin` is not
        // checked either. The handler's default allows only localhost-class origins, against DNS rebinding;
        // here the bearer token guards `/mcp`, and `/api/v1` offers the Agent the same operations
        // with no `Origin` check.
        allowedOriginHostnames: "*",
      },
    );

    // The handler's `fetch` face: the Worker-shaped call would only read OAuth props from the
    // execution context, and `/mcp` has no OAuth.
    return handleMcpRequest.fetch(context.req.raw);
  };
}
