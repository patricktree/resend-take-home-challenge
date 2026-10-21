/*
 * How a Draft is stored: maps the rows of `drafts` and `revisions` to the domain types of
 * `domain/draft.ts`, and selects the row of a Draft's last verdict.
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Temporal } from "temporal-polyfill";

import type { DraftSummary, LastVerdict, RevisionSummary, Sending } from "../domain/draft.ts";
import type { DraftId } from "../domain/ids.ts";
import { revisions, type drafts } from "./schema.ts";

/**
 * Maps a Draft row, its latest Revision row and the row of its last verdict (see
 * {@link selectLastVerdictRow}) to a Draft summary.
 */
export function toDraftSummary(
  draftRow: typeof drafts.$inferSelect,
  latestRevisionRow: typeof revisions.$inferSelect,
  lastVerdictRow: typeof revisions.$inferSelect | undefined,
): DraftSummary {
  return {
    id: draftRow.id,
    createdAt: toInstant(draftRow.createdAt),
    lastActionAt: toInstant(draftRow.lastActionAt),
    latestRevision: toRevisionSummary(latestRevisionRow),
    ...(lastVerdictRow === undefined ? {} : { lastVerdict: toLastVerdict(lastVerdictRow) }),
    sending: toSending(draftRow),
  };
}

/**
 * Selects the row of the Draft's last verdict: its Revision with the highest number that has a
 * verdict. Selects nothing while there is none.
 */
export function selectLastVerdictRow(database: DrizzleD1Database, draftId: DraftId) {
  return database
    .select()
    .from(revisions)
    .where(and(eq(revisions.draftId, draftId), isNotNull(revisions.decidedAt)))
    .orderBy(desc(revisions.revisionNumber))
    .limit(1);
}

/** Maps a Revision row to a Revision summary. */
export function toRevisionSummary(row: typeof revisions.$inferSelect): RevisionSummary {
  return {
    id: row.id,
    revisionNumber: row.revisionNumber,
    createdAt: toInstant(row.createdAt),
    to: row.toAddresses,
    subject: row.subject,
    reviewStatus: row.reviewStatus,
    ...(row.submittedAt === null ? {} : { submittedAt: toInstant(row.submittedAt) }),
    ...(row.decidedAt === null ? {} : { decidedAt: toInstant(row.decidedAt) }),
    ...(row.rejectionReason === null ? {} : { rejectionReason: row.rejectionReason }),
  };
}

/** Reads the verdict of a decided Revision row; the `CHECK` constraints of `revisions` guarantee it. */
function toLastVerdict(row: typeof revisions.$inferSelect): LastVerdict {
  if (
    row.decidedAt === null ||
    (row.reviewStatus !== "APPROVED" && row.reviewStatus !== "REJECTED")
  ) {
    throw new Error(`Revision ${row.id} is ${row.reviewStatus} and has no verdict.`);
  }

  return {
    revisionId: row.id,
    revisionNumber: row.revisionNumber,
    verdict: row.reviewStatus,
    ...(row.rejectionReason === null ? {} : { reason: row.rejectionReason }),
    decidedAt: toInstant(row.decidedAt),
  };
}

/** Reads the sending status; the `CHECK` constraints of `drafts` guarantee the columns it needs. */
function toSending(row: typeof drafts.$inferSelect): Sending {
  if (row.sendingStatus === "SENT") {
    if (row.emailId === null) {
      throw new Error(`Draft ${row.id} is SENT without an email id.`);
    }
    return { status: "SENT", emailId: row.emailId };
  }

  if (row.sendingStatus === "FAILED") {
    if (row.failureReason === null) {
      throw new Error(`Draft ${row.id} is FAILED without a failure reason.`);
    }
    return {
      status: "FAILED",
      failure: {
        reason: row.failureReason,
        ...(row.resendErrorName === null ? {} : { resendErrorName: row.resendErrorName }),
        ...(row.resendErrorMessage === null ? {} : { resendErrorMessage: row.resendErrorMessage }),
      },
    };
  }

  return { status: row.sendingStatus };
}

function toInstant(epochMilliseconds: number): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds);
}
