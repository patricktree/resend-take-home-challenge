import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { RefusalSnapshot, RefusedMutation } from "../domain/refusals.ts";
import { drafts, revisions } from "./schema.ts";

/**
 * Reads the snapshot that tells why a guarded mutation changed nothing: the named Draft's row, and
 * the named Revision's status if it is one of the Draft's Revisions. Call it on the same session as
 * the batch, so that it reads on the primary and at least as new as the batch.
 */
export async function readRefusalSnapshot(
  database: DrizzleD1Database,
  { draftId, revisionId }: RefusedMutation,
): Promise<RefusalSnapshot> {
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
    return { isDraftFound: false };
  }
  return { isDraftFound: true, ...row };
}
