import { createMiddleware } from "hono/factory";
import crypto from "node:crypto";

import {
  ERROR_CODE,
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  OPENAPI_DOCUMENT_PATH,
} from "@draft-approval/api.routes";

import type {
  ApiServerEnvironment,
  ApiServerHonoEnvironment,
} from "#src/api-server-environment.ts";
import { jsonError } from "#src/http-errors.ts";

export type Role = (typeof ROLE)[keyof typeof ROLE];

type TokenConfiguration = {
  agentToken: string;
  /** Absent only in local development. */
  reviewerToken: string | undefined;
  acceptsLocalTokens: boolean;
};

const ROLE = {
  AGENT: "AGENT",
  REVIEWER: "REVIEWER",
} as const;

/**
 * The hosts on which local development accepts the local tokens. On Cloudflare the request host is
 * the routed hostname, which a client cannot set to one of these.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);

/**
 * Requires a bearer token that resolves to a role and sets `role`; a missing or unknown token gets
 * 401 with no hint about which kind was expected. Reading the OpenAPI document is the only public
 * API request.
 */
export const authenticate = createMiddleware<ApiServerHonoEnvironment>(async (context, next) => {
  const isReadingOpenApiDocument =
    (context.req.method === "GET" || context.req.method === "HEAD") &&
    context.req.path === OPENAPI_DOCUMENT_PATH;
  if (isReadingOpenApiDocument) {
    return next();
  }

  const configuration = readTokenConfiguration(context.env, context.req.url);
  const presentedToken = parseBearerToken(context.req.header("Authorization"));
  const role =
    presentedToken === undefined ? undefined : resolveRole(presentedToken, configuration);

  if (role === undefined) {
    return jsonError(
      context,
      401,
      ERROR_CODE.UNAUTHENTICATED,
      "A valid bearer token is required.",
      { headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  context.set("role", role);
  return next();
});

/**
 * Lets only the Reviewer token through, for the routes that render a verdict; any other role gets
 * 403 `REVIEWER_ONLY`. Runs after {@link authenticate} and before any database access, so an Agent
 * can never change a Draft through these routes.
 */
export const requireReviewer = createMiddleware<ApiServerHonoEnvironment>(async (context, next) => {
  if (context.get("role") !== ROLE.REVIEWER) {
    return jsonError(
      context,
      403,
      ERROR_CODE.REVIEWER_ONLY,
      "Only the Reviewer token may approve or reject a Revision.",
    );
  }

  return next();
});

/**
 * Resolves the role of a presented bearer token. The role comes only from which configured token
 * matched, never from the token's prefix.
 *
 * Every candidate is compared, through SHA-256 digests of equal length and in constant time, so the
 * time taken reveals neither which candidate matched nor how much of a token was right.
 */
export function resolveRole(
  presentedToken: string,
  configuration: TokenConfiguration,
): Role | undefined {
  const candidates: { token: string; role: Role }[] = [
    { token: configuration.agentToken, role: ROLE.AGENT },
  ];
  if (configuration.reviewerToken !== undefined) {
    candidates.push({ token: configuration.reviewerToken, role: ROLE.REVIEWER });
  }
  if (configuration.acceptsLocalTokens) {
    candidates.push(
      { token: LOCAL_AGENT_TOKEN, role: ROLE.AGENT },
      { token: LOCAL_REVIEWER_TOKEN, role: ROLE.REVIEWER },
    );
  }

  const presentedDigest = computeDigest(presentedToken);
  let resolvedRole: Role | undefined;
  for (const candidate of candidates) {
    const isMatch = crypto.timingSafeEqual(presentedDigest, computeDigest(candidate.token));
    if (isMatch && resolvedRole === undefined) {
      resolvedRole = candidate.role;
    }
  }

  return resolvedRole;
}

/**
 * Reads the token configuration for one request from the Worker's environment.
 *
 * Throws when the configuration is incomplete: outside local development both tokens must be set.
 */
function readTokenConfiguration(
  environment: ApiServerEnvironment,
  requestUrl: string,
): TokenConfiguration {
  const isLocalDevelopment = environment.LOCAL_DEVELOPMENT === "true";
  const agentToken = nonEmpty(environment.AGENT_TOKEN);
  const reviewerToken = nonEmpty(environment.REVIEWER_TOKEN);

  if (agentToken === undefined) {
    throw new Error("AGENT_TOKEN is not configured.");
  }
  if (reviewerToken === undefined && !isLocalDevelopment) {
    throw new Error("REVIEWER_TOKEN is not configured; only local development may omit it.");
  }
  // Equal tokens would let every Agent act as the Reviewer.
  if (reviewerToken === agentToken) {
    throw new Error("AGENT_TOKEN and REVIEWER_TOKEN must differ.");
  }

  return {
    agentToken,
    reviewerToken,
    acceptsLocalTokens: isLocalDevelopment && LOCAL_HOSTS.has(new URL(requestUrl).hostname),
  };
}

/** Extracts the token of an `Authorization: Bearer <token>` header; the scheme is case-insensitive. */
function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader === undefined) {
    return undefined;
  }

  const match = /^Bearer +(\S+)$/i.exec(authorizationHeader);
  return match?.[1];
}

function computeDigest(token: string): Buffer {
  return crypto.createHash("sha256").update(token).digest();
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}
