import { and, eq } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import type { DraftSummary } from "../domain/draft.ts";
import { isDraftId, isRevisionId } from "../domain/ids.ts";
import {
  explainVerdictRefusal,
  type RefusedMutation,
  type VerdictRefusal,
} from "../domain/refusals.ts";
import type { DraftsStorage } from "../storage/database.ts";
import { toDraftSummary } from "../storage/draft-rows.ts";
import { readRefusalSnapshot } from "../storage/refusal-snapshot.ts";
import { drafts, revisions } from "../storage/schema.ts";
import { isLatestAndPending } from "./verdict-guard.ts";

export type RejectRevisionResult = { outcome: "REJECTED"; draft: DraftSummary } | VerdictRefusal;

type RejectRevisionInput = {
  /** Optional; trimmed, and an empty or whitespace-only reason counts as absent. */
  reason?: string | undefined;
};

/**
 * Rejects one Revision, the Draft's latest and `PENDING`, optionally with a reason. The Draft stays
 * open: the Agent can revise it, building on the Rejected Revision, and submit the new Revision.
 *
 * Runs one guarded batch (spec section 8): every statement carries the guard "the Revision is the
 * Draft's latest and `PENDING`", and the statement that makes it false runs last, so only one
 * verdict per Revision ever commits and a losing Rejection writes nothing. Writes, so the database
 * session must start with `"first-primary"`.
 */
export async function rejectRevision(
  { database }: DraftsStorage,
  draftId: string,
  revisionId: string,
  { reason }: RejectRevisionInput,
): Promise<RejectRevisionResult> {
  if (!isDraftId(draftId)) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (!isRevisionId(revisionId)) {
    return { outcome: "REVISION_NOT_FOUND" };
  }

  const now = Temporal.Now.instant().epochMilliseconds;
  const rejectionReason = reason?.trim() || null;

  const isRevisionLatestAndPending = isLatestAndPending(database, draftId, revisionId);
  const [updatedDrafts, updatedRevisions] = await database.batch([
    database
      .update(drafts)
      .set({ lastActionAt: now })
      .where(and(eq(drafts.id, draftId), isRevisionLatestAndPending))
      .returning(),
    // Leaving `PENDING` makes the guard false, so this statement runs last.
    database
      .update(revisions)
      .set({ reviewStatus: "REJECTED", decidedAt: now, rejectionReason })
      .where(and(eq(revisions.id, revisionId), isRevisionLatestAndPending))
      .returning(),
  ]);

  const [draftRow] = updatedDrafts;
  const [revisionRow] = updatedRevisions;
  if (draftRow === undefined || revisionRow === undefined) {
    const refusedMutation: RefusedMutation = { draftId, revisionId };
    return explainVerdictRefusal(
      refusedMutation,
      await readRefusalSnapshot(database, refusedMutation),
    );
  }

  // The rejected Revision is the latest one, so its verdict is the Draft's last verdict.
  return { outcome: "REJECTED", draft: toDraftSummary(draftRow, revisionRow, revisionRow) };
}
