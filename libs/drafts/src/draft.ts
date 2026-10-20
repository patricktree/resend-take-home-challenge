import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Temporal } from "temporal-polyfill";

import type { DraftId, RevisionId } from "#src/ids.ts";
import { revisions, type drafts, type FailureReason, type ReviewStatus } from "#src/schema.ts";

/** The body of a Revision; an object so that a later `html` becomes a sibling field. */
export type RevisionBody = { plainText: string };

/** The `to` recipients, subject and body of an email. */
export type DraftData = {
  to: string[];
  subject: string;
  body: RevisionBody;
};

/** A Revision without its body, which lives in R2. */
export type RevisionSummary = {
  id: RevisionId;
  revisionNumber: number;
  createdAt: Temporal.Instant;
  to: string[];
  subject: string;
  reviewStatus: ReviewStatus;
  submittedAt?: Temporal.Instant;
  decidedAt?: Temporal.Instant;
  rejectionReason?: string;
};

export type Revision = RevisionSummary & { body: RevisionBody };

/** The verdict a decided Revision has. */
export type Verdict = Extract<ReviewStatus, "APPROVED" | "REJECTED">;

/**
 * The newest verdict on any of a Draft's Revisions: the one with the highest number that has a
 * verdict. Only the latest Revision can get a verdict, so that is also the newest one.
 */
export type LastVerdict = {
  revisionId: RevisionId;
  revisionNumber: number;
  verdict: Verdict;
  reason?: string;
  decidedAt: Temporal.Instant;
};

export type Sending =
  | { status: "NOT_SENT" }
  | { status: "QUEUED" }
  | { status: "SENT"; emailId: string }
  | { status: "FAILED"; failure: SendingFailure };

/** A Draft whose latest Revision comes without its body. */
export type DraftSummary = {
  id: DraftId;
  createdAt: Temporal.Instant;
  lastActionAt: Temporal.Instant;
  latestRevision: RevisionSummary;
  /** Absent while none of the Draft's Revisions has a verdict. */
  lastVerdict?: LastVerdict;
  sending: Sending;
};

export type Draft = Omit<DraftSummary, "latestRevision"> & { latestRevision: Revision };

type SendingFailure = {
  reason: FailureReason;
  resendErrorName?: string;
  resendErrorMessage?: string;
};

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
