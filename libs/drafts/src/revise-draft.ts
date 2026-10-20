import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import type { DraftsStorage } from "#src/database.ts";
import type { DraftData, DraftSummary } from "#src/draft.ts";
import { toDraftSummary } from "#src/draft.ts";
import { createRevisionId, isDraftId, isRevisionId } from "#src/ids.ts";
import { putRevisionBody } from "#src/revision-bodies.ts";
import { drafts, revisions } from "#src/schema.ts";

/** The Draft data of the new Revision and the Revision it builds on. */
export type Revise = DraftData & { baseRevisionId: string };

export type ReviseDraftResult =
  | { outcome: "REVISED"; draft: DraftSummary }
  | { outcome: ReviseDraftRefusal };

/**
 * Why a revise changed nothing, in order of precedence:
 *
 * - `DRAFT_NOT_FOUND`: no Draft has this id;
 * - `DRAFT_APPROVED`: the Draft is approved and accepts no further Revisions;
 * - `REVISION_NOT_FOUND`: the base is not one of the Draft's Revisions;
 * - `REVISION_SUPERSEDED`: the base is not the Draft's latest Revision.
 */
type ReviseDraftRefusal =
  | "DRAFT_NOT_FOUND"
  | "DRAFT_APPROVED"
  | "REVISION_NOT_FOUND"
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
  { baseRevisionId, ...draftData }: Revise,
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
  const [, insertedRevisions, updatedDrafts] = await database.batch([
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
  ]);

  const [revisionRow] = insertedRevisions;
  const [draftRow] = updatedDrafts;
  if (revisionRow !== undefined && draftRow !== undefined) {
    return { outcome: "REVISED", draft: toDraftSummary(draftRow, revisionRow) };
  }

  return { outcome: await explainRefusal(database, draftId, baseRevisionId) };
}

/**
 * Reads why the guarded batch changed nothing. It reads on the same session as the batch, so on the
 * primary and at least as new as the batch.
 */
async function explainRefusal(
  database: DraftsStorage["database"],
  draftId: (typeof drafts.$inferSelect)["id"],
  baseRevisionId: (typeof revisions.$inferSelect)["id"],
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
  if (row.sendingStatus !== "NOT_SENT") {
    return "DRAFT_APPROVED";
  }
  if (row.baseRevisionId === null) {
    return "REVISION_NOT_FOUND";
  }
  if (row.latestRevisionId === baseRevisionId) {
    throw new Error(
      `The revise of Draft ${draftId} changed nothing, although its base ${baseRevisionId} is the latest Revision of a NOT_SENT Draft.`,
    );
  }
  return "REVISION_SUPERSEDED";
}
