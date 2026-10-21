import type { Temporal } from "temporal-polyfill";

import type { DraftId, RevisionId } from "./ids.ts";
import type { FailureReason, ReviewStatus } from "./schema.ts";

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
