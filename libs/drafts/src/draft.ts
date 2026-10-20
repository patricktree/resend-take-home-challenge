import { Temporal } from "temporal-polyfill";

import type { DraftId, RevisionId } from "#src/ids.ts";
import type { drafts, FailureReason, ReviewStatus, revisions } from "#src/schema.ts";

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
  sending: Sending;
};

export type Draft = Omit<DraftSummary, "latestRevision"> & { latestRevision: Revision };

type SendingFailure = {
  reason: FailureReason;
  resendErrorName?: string;
  resendErrorMessage?: string;
};

/** Maps a Draft row and its latest Revision row to a Draft summary. */
export function toDraftSummary(
  draftRow: typeof drafts.$inferSelect,
  latestRevisionRow: typeof revisions.$inferSelect,
): DraftSummary {
  return {
    id: draftRow.id,
    createdAt: toInstant(draftRow.createdAt),
    lastActionAt: toInstant(draftRow.lastActionAt),
    latestRevision: toRevisionSummary(latestRevisionRow),
    sending: toSending(draftRow),
  };
}

function toRevisionSummary(row: typeof revisions.$inferSelect): RevisionSummary {
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
