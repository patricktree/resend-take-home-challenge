/*
 * Records the outcome of a Send on its Draft row (spec section 9, "Recording outcomes"). Every write
 * is conditional on the row, so the first final outcome wins, except that a late `SENT` overrides
 * `OUTCOME_UNKNOWN`. A Send outcome never sets `last_action_at`.
 */

import { and, eq, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { DraftId } from "../domain/ids.ts";
import { drafts } from "./schema.ts";

export type SendFailure =
  /** Resend refused the request: the email definitely did not go out. */
  | { reason: "REJECTED_BY_RESEND"; resendErrorName?: string; resendErrorMessage?: string }
  /** The Send ended without an answer from Resend: the email may have gone out. */
  | { reason: "OUTCOME_UNKNOWN" };

/**
 * Whether the Draft's Send has ended, `SENT` or `FAILED` with either reason. Throws when the Draft
 * has no row, which a Send intent's Draft always has.
 */
export async function hasSendEnded(
  database: DrizzleD1Database,
  draftId: DraftId,
): Promise<boolean> {
  const [row] = await database
    .select({ sendingStatus: drafts.sendingStatus })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  if (row === undefined) {
    throw new Error(`The Draft ${draftId} of a Send intent has no row.`);
  }
  return row.sendingStatus === "SENT" || row.sendingStatus === "FAILED";
}

/**
 * Records `SENT` with Resend's email id, when the Send is still `QUEUED` or ended as `FAILED` /
 * `OUTCOME_UNKNOWN` (then clearing the failure); otherwise changes nothing.
 */
export async function recordSent(
  database: DrizzleD1Database,
  draftId: DraftId,
  emailId: string,
): Promise<void> {
  await database
    .update(drafts)
    .set({
      sendingStatus: "SENT",
      emailId,
      failureReason: null,
      resendErrorName: null,
      resendErrorMessage: null,
    })
    .where(
      and(
        eq(drafts.id, draftId),
        or(
          eq(drafts.sendingStatus, "QUEUED"),
          and(eq(drafts.sendingStatus, "FAILED"), eq(drafts.failureReason, "OUTCOME_UNKNOWN")),
        ),
      ),
    );
}

/** Records `FAILED` with the failure, when the Send is still `QUEUED`; otherwise changes nothing. */
export async function recordFailed(
  database: DrizzleD1Database,
  draftId: DraftId,
  failure: SendFailure,
): Promise<void> {
  await database
    .update(drafts)
    .set({
      sendingStatus: "FAILED",
      failureReason: failure.reason,
      resendErrorName:
        failure.reason === "REJECTED_BY_RESEND" ? (failure.resendErrorName ?? null) : null,
      resendErrorMessage:
        failure.reason === "REJECTED_BY_RESEND" ? (failure.resendErrorMessage ?? null) : null,
    })
    .where(and(eq(drafts.id, draftId), eq(drafts.sendingStatus, "QUEUED")));
}
