/*
 * The Resend adapter: one `POST /emails` with plain `fetch`, no SDK, against `RESEND_BASE_URL`, so
 * that tests point it at a stub (spec section 9, "Queue consumer"). The Send Queue consumer is its
 * only caller.
 */

import { Temporal } from "temporal-polyfill";

import type { ResendCall } from "#src/resend-call-classification.ts";
import { parseRetryAfterSeconds } from "#src/send-retry-delay.ts";

/** Where and as whom the adapter calls Resend. */
export type ResendConnection = {
  /** `RESEND_BASE_URL`, such as `https://api.resend.com`. */
  baseUrl: string;
  /** `RESEND_API_KEY`. */
  apiKey: string;
};

/** Exactly what is sent: the frozen outgoing email, with the approved Revision's body as `text`. */
export type ResendEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  tags: Array<{ name: string; value: string }>;
};

const RESEND_TIMEOUT_MILLISECONDS = 10_000;

/**
 * Calls `POST /emails` once under the idempotency key, with a 10 s timeout that covers the response
 * body too, and reports what came back. Never throws for a failed call.
 */
export async function postEmail(
  { baseUrl, apiKey }: ResendConnection,
  idempotencyKey: string,
  { from, to, subject, text, tags }: ResendEmail,
): Promise<ResendCall> {
  const signal = AbortSignal.timeout(RESEND_TIMEOUT_MILLISECONDS);

  let response: Response;
  let responseText: string;
  try {
    response = await fetch(`${baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        // Resend refuses requests without a User-Agent with 403.
        "User-Agent": "draft-approval",
      },
      // Built field by field, so that every retry sends the same body under the same key.
      body: JSON.stringify({ from, to, subject, text, tags }),
      // A redirect is an unexpected status, which is retried rather than followed.
      redirect: "manual",
      signal,
    });
    responseText = await response.text();
  } catch (error) {
    if (signal.aborted) {
      return { kind: "TIMEOUT" };
    }
    return {
      kind: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const retryAfter = response.headers.get("Retry-After");
  const retryAfterSeconds =
    retryAfter === null
      ? undefined
      : parseRetryAfterSeconds(retryAfter, Temporal.Now.instant().epochMilliseconds);
  return {
    kind: "RESPONSE",
    status: response.status,
    body: parseResponseBody(responseText),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function parseResponseBody(text: string): unknown {
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
