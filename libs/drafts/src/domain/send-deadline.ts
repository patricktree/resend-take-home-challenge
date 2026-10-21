/*
 * The 23 h deadline of a Send (spec section 9, "The 23 h deadline"): Resend keeps an idempotency key
 * for only 24 h, after which the same key and body would send a second email. No Resend call is
 * made later than the deadline, which leaves an hour of margin.
 */

import type { Temporal } from "temporal-polyfill";

const SEND_DEADLINE_AFTER_APPROVAL = { hours: 23 } as const;

/** The deadline of the Send an Approval at `approvedAt` records, in milliseconds since the epoch. */
export function computeSendDeadline(approvedAt: Temporal.Instant): number {
  return approvedAt.add(SEND_DEADLINE_AFTER_APPROVAL).epochMilliseconds;
}

/** Whether no Resend call may be made any more at `now`; a call exactly at the deadline is allowed. */
export function isPastSendDeadline(deadline: number, now: number): boolean {
  return now > deadline;
}
