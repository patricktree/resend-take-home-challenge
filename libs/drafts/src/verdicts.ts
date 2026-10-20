/*
 * What Approval and Rejection share (spec section 8): a verdict names a Draft and a Revision and is
 * accepted only while that Revision is the Draft's latest and `PENDING`.
 */

import { and, eq, exists } from "drizzle-orm";

import type { DraftsStorage } from "#src/database.ts";
import type { Verdict } from "#src/draft.ts";
import type { DraftId, RevisionId } from "#src/ids.ts";
import { drafts, revisions } from "#src/schema.ts";

/**
 * Why a verdict changed nothing, besides `REVISION_ALREADY_DECIDED`, which carries the existing
 * verdict. In order of precedence (a malformed id counts as not found and is refused before
 * anything is read):
 *
 * - `DRAFT_NOT_FOUND`: no Draft has this id;
 * - `REVISION_NOT_FOUND`: the Revision is not one of the Draft's Revisions;
 * - `REVISION_SUPERSEDED`: the Revision is not the Draft's latest;
 * - `REVISION_ALREADY_DECIDED`: the Revision has a verdict, also an identical one;
 * - `REVISION_NOT_SUBMITTED`: the Revision is `UNSUBMITTED`.
 */
export type VerdictRefusal =
  | { outcome: "DRAFT_NOT_FOUND" }
  | { outcome: "REVISION_NOT_FOUND" }
  | { outcome: "REVISION_SUPERSEDED" }
  | { outcome: "REVISION_ALREADY_DECIDED"; existingVerdict: Verdict }
  | { outcome: "REVISION_NOT_SUBMITTED" };

/**
 * The guard of every statement of a verdict batch: the Revision is the Draft's latest and
 * `PENDING`. Setting the verdict makes it false, so that statement runs last.
 */
export function isLatestAndPending(
  database: DraftsStorage["database"],
  draftId: DraftId,
  revisionId: RevisionId,
) {
  return exists(
    database
      .select({ id: drafts.id })
      .from(drafts)
      .innerJoin(revisions, eq(revisions.id, drafts.latestRevisionId))
      .where(
        and(
          eq(drafts.id, draftId),
          eq(drafts.latestRevisionId, revisionId),
          eq(revisions.reviewStatus, "PENDING"),
        ),
      ),
  );
}

/**
 * Reads why a verdict batch changed nothing. It reads on the same session as the batch, so on the
 * primary and at least as new as the batch.
 */
export async function explainVerdictRefusal(
  database: DraftsStorage["database"],
  draftId: DraftId,
  revisionId: RevisionId,
): Promise<VerdictRefusal> {
  const [row] = await database
    .select({
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
  if (row.latestRevisionId !== revisionId) {
    return { outcome: "REVISION_SUPERSEDED" };
  }

  switch (row.revisionReviewStatus) {
    case "APPROVED":
    case "REJECTED": {
      return { outcome: "REVISION_ALREADY_DECIDED", existingVerdict: row.revisionReviewStatus };
    }
    case "UNSUBMITTED": {
      return { outcome: "REVISION_NOT_SUBMITTED" };
    }
    case "PENDING":
    case "SUPERSEDED": {
      throw new Error(
        `The verdict on Revision ${revisionId} changed nothing, although it is the latest Revision of Draft ${draftId} and ${row.revisionReviewStatus}.`,
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
