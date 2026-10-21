import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import type { DraftData, DraftSummary } from "../domain/draft.ts";
import { createRevisionId, isDraftId, isRevisionId } from "../domain/ids.ts";
import { explainReviseRefusal, type ReviseRefusal } from "../domain/refusals.ts";
import type { DraftsStorage } from "../storage/database.ts";
import { selectLastVerdictRow, toDraftSummary } from "../storage/draft-rows.ts";
import { readRefusalSnapshot } from "../storage/refusal-snapshot.ts";
import { putRevisionBody } from "../storage/revision-bodies.ts";
import { drafts, revisions } from "../storage/schema.ts";

/** The Draft data of the new Revision and the Revision it builds on. */
type ReviseDraftInput = DraftData & { baseRevisionId: string };

export type ReviseDraftResult = { outcome: "REVISED"; draft: DraftSummary } | ReviseRefusal;

/**
 * Revises a Draft: creates its next Revision, `UNSUBMITTED`, from the Draft data, provided the base
 * is still the Draft's latest Revision and the Draft is not approved. Building on the Revision the
 * caller last saw refuses lost updates and the duplicate Revisions of retried revises.
 *
 * Writes the body to R2 first, then runs one guarded batch (spec section 8): every statement
 * carries the guard "the base is the Draft's latest Revision and the Draft is `NOT_SENT`", and the
 * statement that makes it false runs last. A revise that loses a race therefore writes no row; it
 * leaves at most an orphaned body in R2. Writes, so the database session must start with
 * `"first-primary"`.
 */
export async function reviseDraft(
  { database, revisionBodies }: DraftsStorage,
  draftId: string,
  { baseRevisionId, ...draftData }: ReviseDraftInput,
): Promise<ReviseDraftResult> {
  if (!isDraftId(draftId)) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (!isRevisionId(baseRevisionId)) {
    return { outcome: "REVISION_NOT_FOUND" };
  }

  const revisionId = createRevisionId();
  const now = Temporal.Now.instant().epochMilliseconds;

  await putRevisionBody(revisionBodies, revisionId, draftData.body);

  const isBaseLatestOfUnapprovedDraft = exists(
    database
      .select({ id: drafts.id })
      .from(drafts)
      .where(
        and(
          eq(drafts.id, draftId),
          eq(drafts.latestRevisionId, baseRevisionId),
          eq(drafts.sendingStatus, "NOT_SENT"),
        ),
      ),
  );
  const [, insertedRevisions, updatedDrafts, lastVerdictRows] = await database.batch([
    // A Rejected base keeps its verdict; only a base without one is superseded.
    database
      .update(revisions)
      .set({ reviewStatus: "SUPERSEDED" })
      .where(
        and(
          eq(revisions.id, baseRevisionId),
          inArray(revisions.reviewStatus, ["UNSUBMITTED", "PENDING"]),
          isBaseLatestOfUnapprovedDraft,
        ),
      ),
    // The columns in table order, as Drizzle's insert-select requires; the number follows the base's.
    database
      .insert(revisions)
      .select(
        database
          .select({
            id: sql`${revisionId}`.as("id"),
            draftId: revisions.draftId,
            revisionNumber: sql`${revisions.revisionNumber} + 1`.as("revision_number"),
            createdAt: sql`${now}`.as("created_at"),
            toAddresses: sql`${JSON.stringify(draftData.to)}`.as("to_addresses"),
            subject: sql`${draftData.subject}`.as("subject"),
            reviewStatus: sql`'UNSUBMITTED'`.as("review_status"),
            submittedAt: sql`NULL`.as("submitted_at"),
            decidedAt: sql`NULL`.as("decided_at"),
            rejectionReason: sql`NULL`.as("rejection_reason"),
          })
          .from(revisions)
          .where(and(eq(revisions.id, baseRevisionId), isBaseLatestOfUnapprovedDraft)),
      )
      .returning(),
    // Moving the latest Revision makes the guard false, so this statement runs last.
    database
      .update(drafts)
      .set({ latestRevisionId: revisionId, lastActionAt: now })
      .where(and(eq(drafts.id, draftId), isBaseLatestOfUnapprovedDraft))
      .returning(),
    // Only reads: a Rejected base stays the last verdict of the revised Draft.
    selectLastVerdictRow(database, draftId),
  ]);

  const [revisionRow] = insertedRevisions;
  const [draftRow] = updatedDrafts;
  if (revisionRow !== undefined && draftRow !== undefined) {
    return {
      outcome: "REVISED",
      draft: toDraftSummary(draftRow, revisionRow, lastVerdictRows[0]),
    };
  }

  return explainReviseRefusal(
    { draftId, revisionId: baseRevisionId },
    await readRefusalSnapshot(database, draftId, baseRevisionId),
  );
}
