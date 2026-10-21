/*
 * How long a retryable Send attempt waits before the Queue delivers its message again (spec
 * section 9, "Classification and backoff"). The 1 s start (Resend's own guidance) makes a one-off
 * 5xx or timeout cost seconds, the 1 h cap and the deadline ride out a long outage, and honoring
 * `Retry-After` keeps a retry out of Resend's rate-limit window.
 */

import assert from "node:assert/strict";
import { Temporal } from "temporal-polyfill";

type RetryDelayInput = {
  /** `message.attempts` of the delivery that failed: 1 for the first delivery. */
  attempts: number;
  /** A random number in [0, 1), the fraction of the 1 s jitter to add. */
  jitter: number;
  /** From Resend's `Retry-After` header, when it sent one. */
  retryAfterSeconds?: number;
  /** The Send's deadline, in milliseconds since the epoch. */
  deadline: number;
  now: number;
};

const INITIAL_BACKOFF_MILLISECONDS = 1000;
const MAXIMUM_BACKOFF_MILLISECONDS = 60 * 60 * 1000;
const MAXIMUM_JITTER_MILLISECONDS = 1000;
/** Cloudflare Queues accept a `delaySeconds` of at most 12 h. */
const MAXIMUM_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

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
 * The `delaySeconds` for `message.retry()`: `max(backoff, Retry-After)`, where the backoff is 1 s ×
 * 2^(attempts − 1), capped at 1 h, plus up to 1 s of jitter, rounded up to whole seconds and
 * clamped so that the next delivery is no later than the deadline.
 */
export function computeRetryDelaySeconds({
  attempts,
  jitter,
  retryAfterSeconds,
  deadline,
  now,
}: RetryDelayInput): number {
  assert(Number.isInteger(attempts) && attempts >= 1, `Invalid number of attempts: ${attempts}`);
  assert(jitter >= 0 && jitter < 1, `Invalid jitter: ${jitter}`);

  const backoffMilliseconds =
    Math.min(INITIAL_BACKOFF_MILLISECONDS * 2 ** (attempts - 1), MAXIMUM_BACKOFF_MILLISECONDS) +
    jitter * MAXIMUM_JITTER_MILLISECONDS;
  const delaySeconds = Math.max(Math.ceil(backoffMilliseconds / 1000), retryAfterSeconds ?? 0);
  const secondsUntilDeadline = Math.max(0, Math.floor((deadline - now) / 1000));

  return Math.min(delaySeconds, secondsUntilDeadline, MAXIMUM_QUEUE_DELAY_SECONDS);
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
