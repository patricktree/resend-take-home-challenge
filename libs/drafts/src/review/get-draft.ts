import { eq } from "drizzle-orm";

import type { Draft } from "../domain/draft.ts";
import { isDraftId } from "../domain/ids.ts";
import type { DraftsStorage } from "../storage/database.ts";
import { selectLastVerdictRow, toDraftSummary } from "../storage/draft-rows.ts";
import { getRevisionBody } from "../storage/revision-bodies.ts";
import { drafts, revisions } from "../storage/schema.ts";

/**
 * Reads a Draft with its latest Revision, that Revision's body and the last verdict; `undefined`
 * when no Draft has this id, including when it is not a Draft id at all.
 */
export async function getDraft(
  { database, revisionBodies }: DraftsStorage,
  draftId: string,
): Promise<Draft | undefined> {
  if (!isDraftId(draftId)) {
    return undefined;
  }

  // One batch reads one consistent state. No join: Drizzle maps a joined select inside a D1 batch
  // by column name, so the columns both tables have (such as `id`) would overwrite each other.
  const [[draftRow], [latestRevisionRow], [lastVerdictRow]] = await database.batch([
    database.select().from(drafts).where(eq(drafts.id, draftId)),
    database
      .select()
      .from(revisions)
      .where(
        eq(
          revisions.id,
          database
            .select({ latestRevisionId: drafts.latestRevisionId })
            .from(drafts)
            .where(eq(drafts.id, draftId)),
        ),
      ),
    selectLastVerdictRow(database, draftId),
  ]);
  if (draftRow === undefined) {
    return undefined;
  }
  if (latestRevisionRow === undefined) {
    throw new Error(`The latest Revision of Draft ${draftId} is missing.`);
  }

  const summary = toDraftSummary(draftRow, latestRevisionRow, lastVerdictRow);
  const body = await getRevisionBody(revisionBodies, summary.latestRevision.id);

  return { ...summary, latestRevision: { ...summary.latestRevision, body } };
}
