/*
 * Why a guarded mutation changed nothing (spec sections 6 and 8): when a revise, Submission or
 * verdict batch changes no row, its use case reads a snapshot of the rows on the primary and picks
 * the refusal here. Every 404 comes before every 409. A malformed id counts as not found and is
 * refused by the use case before anything is read.
 */

import { assertUnreachable } from "../assert-unreachable.ts";
import type { ReviewStatus, SendingStatus, Verdict } from "./draft.ts";
import type { DraftId, RevisionId } from "./ids.ts";

/** The Draft and the Revision a refused mutation named; for a revise, the Revision is its base. */
export type RefusedMutation = { draftId: DraftId; revisionId: RevisionId };

/** The rows a refusal is picked from, read after the batch that changed nothing. */
export type RefusalSnapshot =
  | { isDraftFound: false }
  | {
      isDraftFound: true;
      sendingStatus: SendingStatus;
      latestRevisionId: RevisionId;
      /** The named Revision's status; `null` when it is not one of the Draft's Revisions. */
      revisionReviewStatus: ReviewStatus | null;
    };

/**
 * Why a revise changed nothing, in order of precedence:
 *
 * - `DRAFT_NOT_FOUND`: no Draft has this id;
 * - `REVISION_NOT_FOUND`: the base is not one of the Draft's Revisions;
 * - `DRAFT_APPROVED`: the Draft is approved and accepts no further Revisions;
 * - `REVISION_SUPERSEDED`: the base is not the Draft's latest Revision.
 */
export type ReviseRefusal = {
  outcome: "DRAFT_NOT_FOUND" | "REVISION_NOT_FOUND" | "DRAFT_APPROVED" | "REVISION_SUPERSEDED";
};

/**
 * Why a Submission changed nothing, in order of precedence:
 *
 * - `DRAFT_NOT_FOUND`: no Draft has this id;
 * - `REVISION_NOT_FOUND`: the Revision is not one of the Draft's Revisions;
 * - `DRAFT_APPROVED`: the Draft is approved and accepts no Submission, also of its approved Revision;
 * - `REVISION_SUPERSEDED`: the Revision is not the Draft's latest;
 * - `REVISION_ALREADY_DECIDED`: the Revision has a verdict, which it carries;
 * - `REVISION_ALREADY_SUBMITTED`: the Revision is already `PENDING`.
 */
export type SubmissionRefusal =
  | {
      outcome:
        | "DRAFT_NOT_FOUND"
        | "REVISION_NOT_FOUND"
        | "DRAFT_APPROVED"
        | "REVISION_SUPERSEDED"
        | "REVISION_ALREADY_SUBMITTED";
    }
  | { outcome: "REVISION_ALREADY_DECIDED"; existingVerdict: Verdict };

/**
 * Why a verdict changed nothing, in order of precedence:
 *
 * - `DRAFT_NOT_FOUND`: no Draft has this id;
 * - `REVISION_NOT_FOUND`: the Revision is not one of the Draft's Revisions;
 * - `REVISION_SUPERSEDED`: the Revision is not the Draft's latest;
 * - `REVISION_ALREADY_DECIDED`: the Revision has a verdict, also an identical one, which it carries;
 * - `REVISION_NOT_SUBMITTED`: the Revision is `UNSUBMITTED`.
 */
export type VerdictRefusal =
  | { outcome: "DRAFT_NOT_FOUND" }
  | { outcome: "REVISION_NOT_FOUND" }
  | { outcome: "REVISION_SUPERSEDED" }
  | { outcome: "REVISION_ALREADY_DECIDED"; existingVerdict: Verdict }
  | { outcome: "REVISION_NOT_SUBMITTED" };

/** Picks why a revise changed nothing; throws when the snapshot shows it should have succeeded. */
export function explainReviseRefusal(
  { draftId, revisionId }: RefusedMutation,
  snapshot: RefusalSnapshot,
): ReviseRefusal {
  if (!snapshot.isDraftFound) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (snapshot.revisionReviewStatus === null) {
    return { outcome: "REVISION_NOT_FOUND" };
  }
  if (snapshot.sendingStatus !== "NOT_SENT") {
    return { outcome: "DRAFT_APPROVED" };
  }
  if (snapshot.latestRevisionId !== revisionId) {
    return { outcome: "REVISION_SUPERSEDED" };
  }

  throw new Error(
    `The revise of Draft ${draftId} changed nothing, although its base ${revisionId} is the latest Revision of a NOT_SENT Draft.`,
  );
}

/** Picks why a Submission changed nothing; throws when the snapshot shows it should have succeeded. */
export function explainSubmissionRefusal(
  { draftId, revisionId }: RefusedMutation,
  snapshot: RefusalSnapshot,
): SubmissionRefusal {
  if (!snapshot.isDraftFound) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (snapshot.revisionReviewStatus === null) {
    return { outcome: "REVISION_NOT_FOUND" };
  }
  if (snapshot.sendingStatus !== "NOT_SENT") {
    return { outcome: "DRAFT_APPROVED" };
  }
  if (snapshot.latestRevisionId !== revisionId) {
    return { outcome: "REVISION_SUPERSEDED" };
  }

  switch (snapshot.revisionReviewStatus) {
    case "APPROVED":
    case "REJECTED": {
      return {
        outcome: "REVISION_ALREADY_DECIDED",
        existingVerdict: snapshot.revisionReviewStatus,
      };
    }
    case "PENDING": {
      return { outcome: "REVISION_ALREADY_SUBMITTED" };
    }
    case "UNSUBMITTED":
    case "SUPERSEDED": {
      throw new Error(
        `The Submission of Revision ${revisionId} changed nothing, although it is the latest Revision of the NOT_SENT Draft ${draftId} and ${snapshot.revisionReviewStatus}.`,
      );
    }
    default: {
      return assertUnreachable(snapshot.revisionReviewStatus);
    }
  }
}

/**
 * Picks why a verdict (an Approval or a Rejection) changed nothing; throws when the snapshot shows
 * it should have succeeded. An approved Draft needs no step of its own: its latest Revision is the
 * approved one, which `REVISION_ALREADY_DECIDED` refuses, and every other is
 * `REVISION_SUPERSEDED`.
 */
export function explainVerdictRefusal(
  { draftId, revisionId }: RefusedMutation,
  snapshot: RefusalSnapshot,
): VerdictRefusal {
  if (!snapshot.isDraftFound) {
    return { outcome: "DRAFT_NOT_FOUND" };
  }
  if (snapshot.revisionReviewStatus === null) {
    return { outcome: "REVISION_NOT_FOUND" };
  }
  if (snapshot.latestRevisionId !== revisionId) {
    return { outcome: "REVISION_SUPERSEDED" };
  }

  switch (snapshot.revisionReviewStatus) {
    case "APPROVED":
    case "REJECTED": {
      return {
        outcome: "REVISION_ALREADY_DECIDED",
        existingVerdict: snapshot.revisionReviewStatus,
      };
    }
    case "UNSUBMITTED": {
      return { outcome: "REVISION_NOT_SUBMITTED" };
    }
    case "PENDING":
    case "SUPERSEDED": {
      throw new Error(
        `The verdict on Revision ${revisionId} changed nothing, although it is the latest Revision of Draft ${draftId} and ${snapshot.revisionReviewStatus}.`,
      );
    }
    default: {
      return assertUnreachable(snapshot.revisionReviewStatus);
    }
  }
}
