import { Temporal } from "temporal-polyfill";

import type { DraftsStorage } from "#src/database.ts";
import type { DraftData, DraftSummary } from "#src/draft.ts";
import { toDraftSummary } from "#src/draft.ts";
import { createDraftId, createRevisionId } from "#src/ids.ts";
import { putRevisionBody } from "#src/revision-bodies.ts";
import { drafts, revisions } from "#src/schema.ts";

/**
 * Creates a Draft with its first Revision, `UNSUBMITTED`. Writes the body to R2 first, then inserts
 * the Draft and the Revision in one batch, so a failed batch leaves at most an orphaned body.
 *
 * Not idempotent: every call creates a new Draft. Writes, so the database session must start with
 * `"first-primary"`.
 */
export async function createDraft(
  { database, revisionBodies }: DraftsStorage,
  draftData: DraftData,
): Promise<DraftSummary> {
  const draftId = createDraftId();
  const revisionId = createRevisionId();
  const now = Temporal.Now.instant().epochMilliseconds;

  await putRevisionBody(revisionBodies, revisionId, draftData.body);

  const draftRow: typeof drafts.$inferSelect = {
    id: draftId,
    createdAt: now,
    lastActionAt: now,
    latestRevisionId: revisionId,
    sendingStatus: "NOT_SENT",
    approvedRevisionId: null,
    approvedAt: null,
    idempotencyKey: null,
    outgoingEmail: null,
    deadline: null,
    enqueuedAt: null,
    emailId: null,
    failureReason: null,
    resendErrorName: null,
    resendErrorMessage: null,
  };
  const revisionRow: typeof revisions.$inferSelect = {
    id: revisionId,
    draftId,
    revisionNumber: 1,
    createdAt: now,
    toAddresses: draftData.to,
    subject: draftData.subject,
    reviewStatus: "UNSUBMITTED",
    submittedAt: null,
    decidedAt: null,
    rejectionReason: null,
  };
  // The Draft row goes first: the Revision's foreign key references it.
  await database.batch([
    database.insert(drafts).values(draftRow),
    database.insert(revisions).values(revisionRow),
  ]);

  return toDraftSummary(draftRow, revisionRow);
}
