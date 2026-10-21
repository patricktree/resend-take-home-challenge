import { expect, test } from "vitest";

import {
  explainReviseRefusal,
  explainSubmissionRefusal,
  explainVerdictRefusal,
  type RefusalSnapshot,
  type RefusedMutation,
} from "../src/domain/refusals.ts";

const NAMED: RefusedMutation = {
  draftId: "drf_019a0000-0000-7000-8000-000000000001",
  revisionId: "rev_019a0000-0000-7000-8000-000000000002",
};

const LATER_REVISION_ID = "rev_019a0000-0000-7000-8000-000000000003";

const NO_DRAFT: RefusalSnapshot = { isDraftFound: false };

/** A snapshot of a Draft that has the named Revision with `revisionReviewStatus`. */
function snapshotOf(
  overrides: Partial<Extract<RefusalSnapshot, { isDraftFound: true }>>,
): RefusalSnapshot {
  return {
    isDraftFound: true,
    sendingStatus: "NOT_SENT",
    latestRevisionId: NAMED.revisionId,
    revisionReviewStatus: "UNSUBMITTED",
    ...overrides,
  };
}

test.for([
  { case: "no Draft has the id", snapshot: NO_DRAFT, outcome: "DRAFT_NOT_FOUND" },
  {
    case: "the base is not one of the approved Draft's Revisions",
    snapshot: snapshotOf({ revisionReviewStatus: null, sendingStatus: "QUEUED" }),
    outcome: "REVISION_NOT_FOUND",
  },
  {
    case: "the Draft is approved and the base is not its latest Revision",
    snapshot: snapshotOf({
      revisionReviewStatus: "REJECTED",
      latestRevisionId: LATER_REVISION_ID,
      sendingStatus: "SENT",
    }),
    outcome: "DRAFT_APPROVED",
  },
  {
    case: "the base of a Draft that is not approved is not its latest Revision",
    snapshot: snapshotOf({
      revisionReviewStatus: "SUPERSEDED",
      latestRevisionId: LATER_REVISION_ID,
    }),
    outcome: "REVISION_SUPERSEDED",
  },
])("a revise is refused with $outcome when $case", ({ snapshot, outcome }) => {
  expect(explainReviseRefusal(NAMED, snapshot)).toStrictEqual({ outcome });
});

test("a revise whose base is the latest Revision of a Draft that is not approved has no refusal", () => {
  expect(() =>
    explainReviseRefusal(NAMED, snapshotOf({ revisionReviewStatus: "PENDING" })),
  ).toThrow(/changed nothing/);
});

test.for([
  { case: "no Draft has the id", snapshot: NO_DRAFT, refusal: { outcome: "DRAFT_NOT_FOUND" } },
  {
    case: "the Revision is not one of the approved Draft's Revisions",
    snapshot: snapshotOf({ revisionReviewStatus: null, sendingStatus: "QUEUED" }),
    refusal: { outcome: "REVISION_NOT_FOUND" },
  },
  {
    case: "the Revision is the approved Draft's approved Revision",
    snapshot: snapshotOf({ revisionReviewStatus: "APPROVED", sendingStatus: "QUEUED" }),
    refusal: { outcome: "DRAFT_APPROVED" },
  },
  {
    case: "the Revision is an earlier Revision of an approved Draft",
    snapshot: snapshotOf({
      revisionReviewStatus: "REJECTED",
      latestRevisionId: LATER_REVISION_ID,
      sendingStatus: "FAILED",
    }),
    refusal: { outcome: "DRAFT_APPROVED" },
  },
  {
    case: "the Revision has a verdict and is no longer the latest",
    snapshot: snapshotOf({ revisionReviewStatus: "REJECTED", latestRevisionId: LATER_REVISION_ID }),
    refusal: { outcome: "REVISION_SUPERSEDED" },
  },
  {
    case: "the Revision is the latest and Rejected",
    snapshot: snapshotOf({ revisionReviewStatus: "REJECTED" }),
    refusal: { outcome: "REVISION_ALREADY_DECIDED", existingVerdict: "REJECTED" },
  },
  {
    case: "the Revision is the latest and already Pending",
    snapshot: snapshotOf({ revisionReviewStatus: "PENDING" }),
    refusal: { outcome: "REVISION_ALREADY_SUBMITTED" },
  },
])("a Submission is refused with $refusal.outcome when $case", ({ snapshot, refusal }) => {
  expect(explainSubmissionRefusal(NAMED, snapshot)).toStrictEqual(refusal);
});

test.for(["UNSUBMITTED", "SUPERSEDED"] as const)(
  "a Submission of the latest, %s Revision of a Draft that is not approved has no refusal",
  (revisionReviewStatus) => {
    expect(() => explainSubmissionRefusal(NAMED, snapshotOf({ revisionReviewStatus }))).toThrow(
      /changed nothing/,
    );
  },
);

test.for([
  { case: "no Draft has the id", snapshot: NO_DRAFT, refusal: { outcome: "DRAFT_NOT_FOUND" } },
  {
    case: "the Revision is not one of the approved Draft's Revisions",
    snapshot: snapshotOf({ revisionReviewStatus: null, sendingStatus: "QUEUED" }),
    refusal: { outcome: "REVISION_NOT_FOUND" },
  },
  {
    case: "the Revision has a verdict and is no longer the latest",
    snapshot: snapshotOf({ revisionReviewStatus: "REJECTED", latestRevisionId: LATER_REVISION_ID }),
    refusal: { outcome: "REVISION_SUPERSEDED" },
  },
  {
    case: "the Revision is an earlier Revision of an approved Draft",
    snapshot: snapshotOf({
      revisionReviewStatus: "SUPERSEDED",
      latestRevisionId: LATER_REVISION_ID,
      sendingStatus: "QUEUED",
    }),
    refusal: { outcome: "REVISION_SUPERSEDED" },
  },
  {
    case: "the Revision is the latest and Approved",
    snapshot: snapshotOf({ revisionReviewStatus: "APPROVED", sendingStatus: "QUEUED" }),
    refusal: { outcome: "REVISION_ALREADY_DECIDED", existingVerdict: "APPROVED" },
  },
  {
    case: "the Revision is the latest and Rejected",
    snapshot: snapshotOf({ revisionReviewStatus: "REJECTED" }),
    refusal: { outcome: "REVISION_ALREADY_DECIDED", existingVerdict: "REJECTED" },
  },
  {
    case: "the Revision is the latest and was never submitted",
    snapshot: snapshotOf({ revisionReviewStatus: "UNSUBMITTED" }),
    refusal: { outcome: "REVISION_NOT_SUBMITTED" },
  },
])("a verdict is refused with $refusal.outcome when $case", ({ snapshot, refusal }) => {
  expect(explainVerdictRefusal(NAMED, snapshot)).toStrictEqual(refusal);
});

test.for(["PENDING", "SUPERSEDED"] as const)(
  "a verdict on the latest, %s Revision has no refusal",
  (revisionReviewStatus) => {
    expect(() => explainVerdictRefusal(NAMED, snapshotOf({ revisionReviewStatus }))).toThrow(
      /changed nothing/,
    );
  },
);
