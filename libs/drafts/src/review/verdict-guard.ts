/*
 * The guard Approval and Rejection share (spec section 8): a verdict names a Draft and a Revision
 * and is accepted only while that Revision is the Draft's latest and `PENDING`. Why a verdict was
 * refused is `explainVerdictRefusal()` in `domain/refusals.ts`.
 */

import { and, eq, exists } from "drizzle-orm";

import type { DraftId, RevisionId } from "../domain/ids.ts";
import type { DraftsStorage } from "../storage/database.ts";
import { drafts, revisions } from "../storage/schema.ts";

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
