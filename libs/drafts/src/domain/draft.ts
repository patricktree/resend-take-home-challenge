/*
 * What a Draft is (spec section 3): the domain types, the status values and the outgoing email an
 * Approval freezes. It imports nothing from storage; the Drizzle schema builds its enum columns and
 * `CHECK`s from the status values here.
 */

import type { Temporal } from "temporal-polyfill";

import type { DraftId, RevisionId } from "./ids.ts";

export type SendingStatus = (typeof SENDING_STATUSES)[number];

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SENDING_STATUSES = ["NOT_SENT", "QUEUED", "SENT", "FAILED"] as const;

export const FAILURE_REASONS = ["REJECTED_BY_RESEND", "OUTCOME_UNKNOWN"] as const;

export const REVIEW_STATUSES = [
  "UNSUBMITTED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
] as const;

/** The email an Approval freezes on the Draft row; the Send sends exactly this, with the body. */
export type OutgoingEmail = {
  /** Resolved from `RESEND_FROM` when the Approval is recorded; not part of the review. */
  from: string;
  to: string[];
  subject: string;
  /** The R2 key of the approved Revision's body. */
  bodyKey: string;
  /** Carries the `draft_id` tag from the start: adding it later would change the frozen body. */
  tags: Array<{ name: string; value: string }>;
};

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
  reason: (typeof FAILURE_REASONS)[number];
  resendErrorName?: string;
  resendErrorMessage?: string;
};
