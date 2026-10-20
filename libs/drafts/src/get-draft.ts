import { eq } from "drizzle-orm";

import type { DraftsDatabase } from "#src/database.ts";
import type { Draft } from "#src/draft.ts";
import { toDraftSummary } from "#src/draft.ts";
import { isDraftId } from "#src/ids.ts";
import { getRevisionBody } from "#src/revision-bodies.ts";
import { drafts, revisions } from "#src/schema.ts";

type GetDraftDependencies = {
  database: DraftsDatabase;
  revisionBodies: R2Bucket;
};

/**
 * Reads a Draft with its latest Revision and that Revision's body; `undefined` when no Draft has
 * this id, including when it is not a Draft id at all.
 */
export async function getDraft(
  { database, revisionBodies }: GetDraftDependencies,
  draftId: string,
): Promise<Draft | undefined> {
  if (!isDraftId(draftId)) {
    return undefined;
  }

  const [row] = await database
    .select()
    .from(drafts)
    .innerJoin(revisions, eq(revisions.id, drafts.latestRevisionId))
    .where(eq(drafts.id, draftId));
  if (row === undefined) {
    return undefined;
  }

  const summary = toDraftSummary(row.drafts, row.revisions);
  const body = await getRevisionBody(revisionBodies, summary.latestRevision.id);

  return { ...summary, latestRevision: { ...summary.latestRevision, body } };
}
