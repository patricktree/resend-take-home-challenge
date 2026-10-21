/*
 * The Resend adapter: one `POST /emails` with plain `fetch`, no SDK, against `RESEND_BASE_URL`, so
 * that tests point it at a stub (spec section 9, "Queue consumer"). The Send Queue consumer is its
 * only caller. It also reads the `Retry-After` header, so the retry policy gets plain seconds.
 */

import { Temporal } from "temporal-polyfill";

import type { ResendCall } from "./resend-call-classification.ts";

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

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** An IMF-fixdate, such as `Wed, 21 Oct 2026 07:28:00 GMT`. */
const IMF_FIXDATE_PATTERN = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) (${MONTH_NAMES.join("|")}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);

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
        "User-Agent": "resend-challenge",
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

/**
 * Reads a `Retry-After` header (https://www.rfc-editor.org/rfc/rfc9110#field.retry-after):
 * delta-seconds, or an HTTP date in the IMF-fixdate format that senders must use; `undefined` when
 * it is unreadable. Resend's own 429s carry delta-seconds, but every retryable response is read
 * here, also a 429 or 503 from a proxy or load balancer in front of Resend, and RFC 9110 allows
 * either form, so both are handled.
 */
export function parseRetryAfterSeconds(value: string, now: number): number | undefined {
  const trimmedValue = value.trim();
  if (/^\d+$/.test(trimmedValue)) {
    return Number.parseInt(trimmedValue, 10);
  }

  const date = parseImfFixdate(trimmedValue);
  if (date === undefined) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date.epochMilliseconds - now) / 1000));
}

function parseImfFixdate(value: string): Temporal.Instant | undefined {
  const match = IMF_FIXDATE_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }

  const [, day, monthName, year, hour, minute, second] = match;
  try {
    return Temporal.PlainDateTime.from(
      {
        year: Number(year),
        month: MONTH_NAMES.findIndex((name) => name === monthName) + 1,
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
      },
      { overflow: "reject" },
    )
      .toZonedDateTime("UTC")
      .toInstant();
  } catch {
    // An impossible date, such as 31 Feb.
    return undefined;
  }
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
