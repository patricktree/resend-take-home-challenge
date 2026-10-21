import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import { createDraft } from "../src/review/create-draft.ts";
import { rejectRevision } from "../src/review/reject-revision.ts";
import { reviseDraft } from "../src/review/revise-draft.ts";
import { submitRevision } from "../src/review/submit-revision.ts";
import { drizzleForSession, type DraftsStorage } from "../src/storage/database.ts";
import { createHoldingD1Database } from "./holding-d1-database.ts";
import { useBindings, type TestBindings } from "./use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

test("a Rejection records the verdict and its reason on the Revision and leaves the Draft NOT_SENT", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const storage = storageOn(bindings.DB, bindings);
  const created = await createDraft(storage, DRAFT_DATA);
  const revisionId = created.latestRevision.id;
  await submitRevision(storage, created.id, revisionId);

  const result = await rejectRevision(storage, created.id, revisionId, {
    reason: "Wrong recipient",
  });

  const { drafts, revisions } = await readRows(bindings.DB);
  const decidedAt = Number(revisions?.[0]?.["decided_at"]);
  const decidedAtInstant = Temporal.Instant.fromEpochMilliseconds(decidedAt);
  expect(result).toStrictEqual({
    outcome: "REJECTED",
    draft: {
      ...created,
      lastActionAt: decidedAtInstant,
      latestRevision: {
        ...created.latestRevision,
        reviewStatus: "REJECTED",
        submittedAt: expect.any(Temporal.Instant),
        decidedAt: decidedAtInstant,
        rejectionReason: "Wrong recipient",
      },
      lastVerdict: {
        revisionId,
        revisionNumber: 1,
        verdict: "REJECTED",
        reason: "Wrong recipient",
        decidedAt: decidedAtInstant,
      },
      sending: { status: "NOT_SENT" },
    },
  });
  expect(drafts).toMatchObject([
    { sending_status: "NOT_SENT", approved_revision_id: null, last_action_at: decidedAt },
  ]);
  expect(revisions).toMatchObject([
    { id: revisionId, review_status: "REJECTED", rejection_reason: "Wrong recipient" },
  ]);
});

test.for([
  { name: "without a reason", reason: undefined },
  { name: "with an empty reason", reason: "" },
  { name: "with a whitespace-only reason", reason: " \n\t " },
])("a Rejection $name records no reason", async ({ reason }, { expect, onTestFinished }) => {
  const bindings = await useBindings({ onTestFinished });
  const storage = storageOn(bindings.DB, bindings);
  const created = await createDraft(storage, DRAFT_DATA);
  await submitRevision(storage, created.id, created.latestRevision.id);

  const result = await rejectRevision(storage, created.id, created.latestRevision.id, { reason });

  expect(result).toMatchObject({
    outcome: "REJECTED",
    draft: { lastVerdict: { verdict: "REJECTED" } },
  });
  expect(result).not.toHaveProperty("draft.latestRevision.rejectionReason");
  expect(result).not.toHaveProperty("draft.lastVerdict.reason");
  const { revisions } = await readRows(bindings.DB);
  expect(revisions).toMatchObject([{ review_status: "REJECTED", rejection_reason: null }]);
});

test("a Rejection trims its reason", async ({ expect, onTestFinished }) => {
  const bindings = await useBindings({ onTestFinished });
  const storage = storageOn(bindings.DB, bindings);
  const created = await createDraft(storage, DRAFT_DATA);
  await submitRevision(storage, created.id, created.latestRevision.id);

  await rejectRevision(storage, created.id, created.latestRevision.id, {
    reason: "  Wrong recipient\n",
  });

  const { revisions } = await readRows(bindings.DB);
  expect(revisions).toMatchObject([{ rejection_reason: "Wrong recipient" }]);
});

test("reject ‖ revise, revise first: the Rejection gets REVISION_SUPERSEDED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const holdingDatabase = createHoldingD1Database(bindings.DB);
  const created = await createSubmittedDraft(bindings);

  const hold = holdingDatabase.holdNext((call) => call.kind === "batch");
  const heldRejection = rejectRevision(
    storageOn(holdingDatabase.database, bindings),
    created.id,
    created.latestRevision.id,
    { reason: "Wrong recipient" },
  );
  await hold.reached;
  const committedRevise = await reviseDraft(storageOn(bindings.DB, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Committed revise",
    baseRevisionId: created.latestRevision.id,
  });
  const rowsAfterCommittedRevise = await readRows(bindings.DB);
  hold.release();

  expect(committedRevise).toMatchObject({ outcome: "REVISED" });
  expect(await heldRejection).toStrictEqual({ outcome: "REVISION_SUPERSEDED" });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedRevise);
  expect(rowsAfterCommittedRevise.revisions).toMatchObject([
    { revision_number: 1, review_status: "SUPERSEDED", decided_at: null },
    { revision_number: 2, review_status: "UNSUBMITTED" },
  ]);
});

test("reject ‖ revise, reject first: the revise builds on the Rejected Revision, which stays Rejected", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const holdingDatabase = createHoldingD1Database(bindings.DB);
  const created = await createSubmittedDraft(bindings);
  const rejectedRevisionId = created.latestRevision.id;

  const hold = holdingDatabase.holdNext((call) => call.kind === "batch");
  const heldRevise = reviseDraft(storageOn(holdingDatabase.database, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Held revise",
    baseRevisionId: rejectedRevisionId,
  });
  await hold.reached;
  const committedRejection = await rejectRevision(
    storageOn(bindings.DB, bindings),
    created.id,
    rejectedRevisionId,
    { reason: "Wrong recipient" },
  );
  hold.release();
  const reviseOutcome = await heldRevise;

  expect(committedRejection).toMatchObject({ outcome: "REJECTED" });
  expect(reviseOutcome).toMatchObject({
    outcome: "REVISED",
    draft: {
      latestRevision: { revisionNumber: 2, subject: "Held revise", reviewStatus: "UNSUBMITTED" },
      lastVerdict: {
        revisionId: rejectedRevisionId,
        revisionNumber: 1,
        verdict: "REJECTED",
        reason: "Wrong recipient",
      },
    },
  });
  const { revisions } = await readRows(bindings.DB);
  expect(revisions).toMatchObject([
    { id: rejectedRevisionId, review_status: "REJECTED", rejection_reason: "Wrong recipient" },
    { revision_number: 2, review_status: "UNSUBMITTED" },
  ]);
});

/** Creates a Draft and submits its first Revision, so that it awaits a verdict. */
async function createSubmittedDraft(bindings: TestBindings) {
  const storage = storageOn(bindings.DB, bindings);
  const created = await createDraft(storage, DRAFT_DATA);
  const submitted = await submitRevision(storage, created.id, created.latestRevision.id);
  if (submitted.outcome !== "SUBMITTED") {
    throw new Error(`The Submission ended with ${submitted.outcome}.`);
  }
  return submitted.draft;
}

function storageOn(database: D1Database, bindings: TestBindings): DraftsStorage {
  return {
    database: drizzleForSession(database, "first-primary").database,
    revisionBodies: bindings.REVISION_BODIES,
  };
}

async function readRows(database: D1Database) {
  const [drafts, revisions] = await database.batch<Record<string, unknown>>([
    database.prepare("SELECT * FROM drafts ORDER BY id"),
    database.prepare("SELECT * FROM revisions ORDER BY draft_id, revision_number"),
  ]);
  return { drafts: drafts?.results, revisions: revisions?.results };
}
