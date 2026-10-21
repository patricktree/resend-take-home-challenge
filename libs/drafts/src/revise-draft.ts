import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import type { DraftsStorage } from "./database.ts";
import type { DraftData, DraftSummary } from "./draft.ts";
import { selectLastVerdictRow, toDraftSummary } from "./draft.ts";
import { createRevisionId, isDraftId, isRevisionId, type DraftId, type RevisionId } from "./ids.ts";
import { putRevisionBody } from "./revision-bodies.ts";
import { drafts, revisions } from "./schema.ts";

/** The Draft data of the new Revision and the Revision it builds on. */
type ReviseDraftInput = DraftData & { baseRevisionId: string };

export type ReviseDraftResult =
  | { outcome: "REVISED"; draft: DraftSummary }
  | { outcome: ReviseDraftRefusal };

/**
 * Why a revise changed nothing, in order of precedence (a malformed id counts as not found and is
 * refused before anything is read):
 *
 * - `DRAFT_NOT_FOUND`: no Draft has this id;
 * - `REVISION_NOT_FOUND`: the base is not one of the Draft's Revisions;
 * - `DRAFT_APPROVED`: the Draft is approved and accepts no further Revisions;
 * - `REVISION_SUPERSEDED`: the base is not the Draft's latest Revision.
 *
 * Every 404 comes before every 409, as for Submissions and verdicts.
 */
type ReviseDraftRefusal =
  | "DRAFT_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "DRAFT_APPROVED"
  | "REVISION_SUPERSEDED";

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

  return { outcome: await explainRefusal(database, draftId, baseRevisionId) };
}

/**
 * Reads why the guarded batch changed nothing. It reads on the same session as the batch, so on the
 * primary and at least as new as the batch.
 */
async function explainRefusal(
  database: DraftsStorage["database"],
  draftId: DraftId,
  baseRevisionId: RevisionId,
): Promise<ReviseDraftRefusal> {
  const [row] = await database
    .select({
      sendingStatus: drafts.sendingStatus,
      latestRevisionId: drafts.latestRevisionId,
      baseRevisionId: revisions.id,
    })
    .from(drafts)
    .leftJoin(revisions, and(eq(revisions.id, baseRevisionId), eq(revisions.draftId, drafts.id)))
    .where(eq(drafts.id, draftId));

  if (row === undefined) {
    return "DRAFT_NOT_FOUND";
  }
  if (row.baseRevisionId === null) {
    return "REVISION_NOT_FOUND";
  }
  if (row.sendingStatus !== "NOT_SENT") {
    return "DRAFT_APPROVED";
  }
  if (row.latestRevisionId === baseRevisionId) {
    throw new Error(
      `The revise of Draft ${draftId} changed nothing, although its base ${baseRevisionId} is the latest Revision of a NOT_SENT Draft.`,
    );
  }
  return "REVISION_SUPERSEDED";
}
