/*
 * How long a retryable Send attempt waits before the Queue delivers its message again (spec
 * section 9, "Classification and backoff"). The 1 s start (Resend's own guidance) makes a one-off
 * 5xx or timeout cost seconds, the 1 h cap and the deadline ride out a long outage, and honoring
 * `Retry-After` keeps a retry out of Resend's rate-limit window.
 */

import assert from "node:assert/strict";

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
/**
 * Cloudflare Queues accept a `delaySeconds` of at most 12 h. The backoff stops at 1 h, so only a
 * longer `Retry-After` (for example on a daily-quota 429) reaches this cap.
 */
const MAXIMUM_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

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
