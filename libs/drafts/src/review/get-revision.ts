import { and, eq } from "drizzle-orm";

import type { Revision } from "../domain/draft.ts";
import { isDraftId, isRevisionId } from "../domain/ids.ts";
import type { DraftsStorage } from "../storage/database.ts";
import { toRevisionSummary } from "../storage/draft-rows.ts";
import { getRevisionBody } from "../storage/revision-bodies.ts";
import { drafts, revisions } from "../storage/schema.ts";

export type GetRevisionResult =
  | { outcome: "FOUND"; revision: Revision }
  | { outcome: "DRAFT_NOT_FOUND" | "REVISION_NOT_FOUND" };

/**
 * Reads any of a Draft's Revisions with its body, including Superseded ones. A Revision of another
 * Draft counts as not found, so a Revision id is only ever read through its own Draft. A malformed
 * id counts as not found and is refused before anything is read.
 */
export async function getRevision(
  { database, revisionBodies }: DraftsStorage,
  draftId: string,
  revisionId: string,
): Promise<GetRevisionResult> {
  if (!isDraftId(draftId)) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (!isRevisionId(revisionId)) {
    return { outcome: "REVISION_NOT_FOUND" };
  }

  // One query tells an unknown Draft (no row) from an unknown Revision (no joined Revision).
  const [row] = await database
    .select({ draftId: drafts.id, revision: revisions })
    .from(drafts)
    .leftJoin(revisions, and(eq(revisions.id, revisionId), eq(revisions.draftId, drafts.id)))
    .where(eq(drafts.id, draftId));
  if (row === undefined) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (row.revision === null) {
    return { outcome: "REVISION_NOT_FOUND" };
  }

  const body = await getRevisionBody(revisionBodies, row.revision.id);
  return { outcome: "FOUND", revision: { ...toRevisionSummary(row.revision), body } };
}
