import { and, eq, exists } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import type { DraftSummary } from "../domain/draft.ts";
import { isDraftId, isRevisionId } from "../domain/ids.ts";
import { explainSubmissionRefusal, type SubmissionRefusal } from "../domain/refusals.ts";
import type { DraftsStorage } from "../storage/database.ts";
import { selectLastVerdictRow, toDraftSummary } from "../storage/draft-rows.ts";
import { readRefusalSnapshot } from "../storage/refusal-snapshot.ts";
import { drafts, revisions } from "../storage/schema.ts";

export type SubmitRevisionResult =
  | { outcome: "SUBMITTED"; draft: DraftSummary }
  | SubmissionRefusal;

/**
 * Submits one Revision for review: it becomes `PENDING`, and with it the Draft, provided it is the
 * Draft's latest Revision and `UNSUBMITTED`. Each Revision is submitted at most once.
 *
 * Runs one guarded batch (spec section 8): every statement carries the guard "the Revision is the
 * Draft's latest and `UNSUBMITTED`", and the statement that makes it false runs last. A Submission
 * that loses a race therefore writes nothing. Writes, so the database session must start with
 * `"first-primary"`.
 */
export async function submitRevision(
  { database }: DraftsStorage,
  draftId: string,
  revisionId: string,
): Promise<SubmitRevisionResult> {
  if (!isDraftId(draftId)) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (!isRevisionId(revisionId)) {
    return { outcome: "REVISION_NOT_FOUND" };
  }

  const now = Temporal.Now.instant().epochMilliseconds;

  const isLatestAndUnsubmitted = exists(
    database
      .select({ id: drafts.id })
      .from(drafts)
      .innerJoin(revisions, eq(revisions.id, drafts.latestRevisionId))
      .where(
        and(
          eq(drafts.id, draftId),
          eq(drafts.latestRevisionId, revisionId),
          eq(revisions.reviewStatus, "UNSUBMITTED"),
        ),
      ),
  );
  const [updatedDrafts, updatedRevisions, lastVerdictRows] = await database.batch([
    database
      .update(drafts)
      .set({ lastActionAt: now })
      .where(and(eq(drafts.id, draftId), isLatestAndUnsubmitted))
      .returning(),
    // Leaving `UNSUBMITTED` makes the guard false, so this statement runs last.
    database
      .update(revisions)
      .set({ reviewStatus: "PENDING", submittedAt: now })
      .where(and(eq(revisions.id, revisionId), isLatestAndUnsubmitted))
      .returning(),
    // Only reads: the verdict on an earlier Revision, such as a Rejection the Agent revised after.
    selectLastVerdictRow(database, draftId),
  ]);

  const [draftRow] = updatedDrafts;
  const [revisionRow] = updatedRevisions;
  if (draftRow !== undefined && revisionRow !== undefined) {
    return {
      outcome: "SUBMITTED",
      draft: toDraftSummary(draftRow, revisionRow, lastVerdictRows[0]),
    };
  }

  return explainSubmissionRefusal(
    { draftId, revisionId },
    await readRefusalSnapshot(database, draftId, revisionId),
  );
}
