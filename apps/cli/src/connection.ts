import { ApiClient } from "@resend-challenge/api.client";
import { ERROR_CODE } from "@resend-challenge/api.client";

import { CLI_ERROR_CODE, CliError } from "./cli-error.ts";
import { PRODUCTION_API_URL } from "./production.ts";

export const ENVIRONMENT_VARIABLE = {
  TOKEN: "RESEND_CHALLENGE_TOKEN",
  API_URL: "RESEND_CHALLENGE_API_URL",
} as const;

/** Plain HTTP is allowed only on these hosts, where nothing leaves the machine. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Creates the typed client for one invocation: the API URL from `--api-url`, then
 * `RESEND_CHALLENGE_API_URL`, then production; the token from `RESEND_CHALLENGE_TOKEN`, which is
 * required.
 */
export function createClient(
  apiUrlOption: string | undefined,
  environment: NodeJS.ProcessEnv,
): ApiClient {
  const apiUrl = resolveApiUrl(
    apiUrlOption ?? readNonEmpty(environment, ENVIRONMENT_VARIABLE.API_URL) ?? PRODUCTION_API_URL,
  );
  const token = readNonEmpty(environment, ENVIRONMENT_VARIABLE.TOKEN);
  if (token === undefined) {
    throw new CliError(
      CLI_ERROR_CODE.TOKEN_NOT_SET,
      `${ENVIRONMENT_VARIABLE.TOKEN} is not set. The CLI sends it as the Agent token; set it to the Agent token, which the repository owner hands out.`,
    );
  }

  return new ApiClient({
    baseUrl: apiUrl.origin,
    token,
    fetch: async (request) => {
      try {
        return await fetch(request);
      } catch (error) {
        throw new CliError(
          CLI_ERROR_CODE.NETWORK_ERROR,
          `Could not reach the API at ${apiUrl.origin}: ${describeNetworkFailure(error)}.`,
        );
      }
    },
  });
}

/** The bearer token must never cross the network in plain text, so HTTPS is required off loopback. */
function resolveApiUrl(configuredApiUrl: string): URL {
  let apiUrl: URL;
  try {
    apiUrl = new URL(configuredApiUrl);
  } catch {
    throw new CliError(
      ERROR_CODE.INVALID_REQUEST,
      `The API URL "${configuredApiUrl}" is not a URL.`,
    );
  }

  const isHttps = apiUrl.protocol === "https:";
  const isLoopbackHttp = apiUrl.protocol === "http:" && LOOPBACK_HOSTNAMES.has(apiUrl.hostname);
  if (!isHttps && !isLoopbackHttp) {
    throw new CliError(
      ERROR_CODE.INVALID_REQUEST,
      `The API URL "${apiUrl.origin}" must use HTTPS; plain HTTP is allowed only on localhost, 127.0.0.1 and [::1].`,
    );
  }

  // The routes carry their full paths (`/api/v1/…`), so anything after the origin would be dropped.
  if (apiUrl.pathname !== "/" || apiUrl.search !== "" || apiUrl.hash !== "") {
    throw new CliError(
      ERROR_CODE.INVALID_REQUEST,
      `The API URL "${configuredApiUrl}" must be an origin, such as ${PRODUCTION_API_URL}, without a path.`,
    );
  }
  return apiUrl;
}

/** An empty variable counts as unset, as with `RESEND_CHALLENGE_TOKEN= pnpm resend-challenge …`. */
function readNonEmpty(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * `fetch` rejects with a generic "fetch failed" and keeps the reason, such as ECONNREFUSED, in
 * `cause`.
 */
function describeNetworkFailure(error: unknown): string {
  if (error instanceof Error && error.cause instanceof Error) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : "the request failed";
}
