import { and, eq, exists } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import type { DraftsStorage } from "./database.ts";
import type { DraftSummary, Verdict } from "./draft.ts";
import { selectLastVerdictRow, toDraftSummary } from "./draft.ts";
import { isDraftId, isRevisionId, type DraftId, type RevisionId } from "./ids.ts";
import { drafts, revisions } from "./schema.ts";

export type SubmitRevisionResult =
  | { outcome: "SUBMITTED"; draft: DraftSummary }
  | { outcome: "REVISION_ALREADY_DECIDED"; existingVerdict: Verdict }
  | { outcome: SubmitRevisionRefusal };

/**
 * Why a Submission changed nothing, besides `REVISION_ALREADY_DECIDED`, which carries the existing
 * verdict. In order of precedence (a malformed id counts as not found and is refused before
 * anything is read):
 *
 * - `DRAFT_NOT_FOUND`: no Draft has this id;
 * - `REVISION_NOT_FOUND`: the Revision is not one of the Draft's Revisions;
 * - `DRAFT_APPROVED`: the Draft is approved and accepts no Submission, also of its approved Revision;
 * - `REVISION_SUPERSEDED`: the Revision is not the Draft's latest;
 * - `REVISION_ALREADY_DECIDED`: the Revision has a verdict;
 * - `REVISION_ALREADY_SUBMITTED`: the Revision is already `PENDING`.
 */
type SubmitRevisionRefusal =
  | "DRAFT_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "DRAFT_APPROVED"
  | "REVISION_SUPERSEDED"
  | "REVISION_ALREADY_SUBMITTED";

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

  return explainRefusal(database, draftId, revisionId);
}

/**
 * Reads why the guarded batch changed nothing. It reads on the same session as the batch, so on the
 * primary and at least as new as the batch.
 */
async function explainRefusal(
  database: DraftsStorage["database"],
  draftId: DraftId,
  revisionId: RevisionId,
): Promise<Exclude<SubmitRevisionResult, { outcome: "SUBMITTED" }>> {
  const [row] = await database
    .select({
      sendingStatus: drafts.sendingStatus,
      latestRevisionId: drafts.latestRevisionId,
      revisionReviewStatus: revisions.reviewStatus,
    })
    .from(drafts)
    .leftJoin(revisions, and(eq(revisions.id, revisionId), eq(revisions.draftId, drafts.id)))
    .where(eq(drafts.id, draftId));

  if (row === undefined) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (row.revisionReviewStatus === null) {
    return { outcome: "REVISION_NOT_FOUND" };
  }
  if (row.sendingStatus !== "NOT_SENT") {
    return { outcome: "DRAFT_APPROVED" };
  }
  if (row.latestRevisionId !== revisionId) {
    return { outcome: "REVISION_SUPERSEDED" };
  }

  switch (row.revisionReviewStatus) {
    case "APPROVED":
    case "REJECTED": {
      return { outcome: "REVISION_ALREADY_DECIDED", existingVerdict: row.revisionReviewStatus };
    }
    case "PENDING": {
      return { outcome: "REVISION_ALREADY_SUBMITTED" };
    }
    case "UNSUBMITTED":
    case "SUPERSEDED": {
      throw new Error(
        `The Submission of Revision ${revisionId} changed nothing, although it is the latest Revision of the NOT_SENT Draft ${draftId} and ${row.revisionReviewStatus}.`,
      );
    }
    default: {
      return assertUnreachable(row.revisionReviewStatus);
    }
  }
}

/** Fails to compile when a switch misses a case, and throws if an unexpected value arrives anyway. */
function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
