import React from "react";

import { ApiError } from "@resend-challenge/api.client";

type ErrorMessageProps = {
  /** What a route or query threw; React rendering can throw anything, not only errors. */
  error: unknown;
};

/**
 * An error's message and, for an API error, its request id. Renders nothing for a 401: the app then
 * shows the token screen instead.
 */
export function ErrorMessage({ error }: ErrorMessageProps): React.ReactNode {
  if (error instanceof ApiError && error.status === 401) {
    return null;
  }

  return (
    <div role="alert">
      <p>{error instanceof Error ? error.message : String(error)}</p>
      {error instanceof ApiError && <p>Request ID: {error.requestId}</p>}
    </div>
  );
}
