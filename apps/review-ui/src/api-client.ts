import { ApiClient } from "@resend-challenge/api.client";

import { readReviewerSession } from "./reviewer-session.ts";

let cachedClient: { token: string; client: ApiClient } | undefined;

/**
 * The typed client with the stored Reviewer token. It is kept per token, so its read bookmark
 * carries over from one request to the next and the Reviewer reads their own verdicts.
 *
 * Throws when no token is stored: the app renders the token screen instead of anything that calls
 * the API.
 */
export function getApiClient(): ApiClient {
  const { token } = readReviewerSession();
  if (token === undefined) {
    throw new Error("No Reviewer token is stored; the token screen must be shown instead.");
  }

  if (cachedClient?.token !== token) {
    // The Review UI and the API share one origin.
    cachedClient = {
      token,
      client: new ApiClient({ baseUrl: location.origin, token }),
    };
  }
  return cachedClient.client;
}
