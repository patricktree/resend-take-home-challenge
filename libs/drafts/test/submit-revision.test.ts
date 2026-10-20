import { test } from "vitest";

import { createDraft } from "#src/create-draft.ts";
import { drizzleForSession, type DraftsStorage } from "#src/database.ts";
import { reviseDraft } from "#src/revise-draft.ts";
import { submitRevision } from "#src/submit-revision.ts";

import { createGatedD1Database } from "#test/gated-d1-database.ts";
import { useBindings, type TestBindings } from "#test/use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

test("submit ‖ submit: the Submission whose batch commits second gets REVISION_ALREADY_SUBMITTED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const created = await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);
  const revisionId = created.latestRevision.id;

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldSubmission = submitRevision(
    storageOn(gatedDatabase.database, bindings),
    created.id,
    revisionId,
  );
  await gate.reached;
  const committedSubmission = await submitRevision(
    storageOn(bindings.DB, bindings),
    created.id,
    revisionId,
  );
  const rowsAfterCommittedSubmission = await readRows(bindings.DB);
  gate.release();

  expect(committedSubmission).toMatchObject({
    outcome: "SUBMITTED",
    draft: { latestRevision: { id: revisionId, reviewStatus: "PENDING" } },
  });
  expect(await heldSubmission).toStrictEqual({ outcome: "REVISION_ALREADY_SUBMITTED" });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedSubmission);
  expect(rowsAfterCommittedSubmission.revisions).toMatchObject([
    { id: revisionId, review_status: "PENDING" },
  ]);
});

test("submit ‖ revise, revise first: the Submission gets REVISION_SUPERSEDED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const created = await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldSubmission = submitRevision(
    storageOn(gatedDatabase.database, bindings),
    created.id,
    created.latestRevision.id,
  );
  await gate.reached;
  const committedRevise = await reviseDraft(storageOn(bindings.DB, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Committed revise",
    baseRevisionId: created.latestRevision.id,
  });
  const rowsAfterCommittedRevise = await readRows(bindings.DB);
  gate.release();

  expect(committedRevise).toMatchObject({
    outcome: "REVISED",
    draft: { latestRevision: { revisionNumber: 2, reviewStatus: "UNSUBMITTED" } },
  });
  expect(await heldSubmission).toStrictEqual({ outcome: "REVISION_SUPERSEDED" });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedRevise);
  expect(rowsAfterCommittedRevise.revisions).toMatchObject([
    { revision_number: 1, review_status: "SUPERSEDED", submitted_at: null },
    { revision_number: 2, review_status: "UNSUBMITTED", submitted_at: null },
  ]);
});

test("submit ‖ revise, submit first: the revise supersedes the now-Pending Revision", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const created = await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldRevise = reviseDraft(storageOn(gatedDatabase.database, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Held revise",
    baseRevisionId: created.latestRevision.id,
  });
  await gate.reached;
  const committedSubmission = await submitRevision(
    storageOn(bindings.DB, bindings),
    created.id,
    created.latestRevision.id,
  );
  gate.release();
  const reviseOutcome = await heldRevise;

  expect(committedSubmission).toMatchObject({ outcome: "SUBMITTED" });
  expect(reviseOutcome).toMatchObject({
    outcome: "REVISED",
    draft: {
      latestRevision: { revisionNumber: 2, subject: "Held revise", reviewStatus: "UNSUBMITTED" },
    },
  });
  const { revisions } = await readRows(bindings.DB);
  // The Pending base keeps its `submitted_at`: superseding withdraws the Submission, not its record.
  expect(revisions).toMatchObject([
    { revision_number: 1, review_status: "SUPERSEDED", submitted_at: expect.any(Number) },
    { revision_number: 2, review_status: "UNSUBMITTED", submitted_at: null },
  ]);
  const latestRevisions = await bindings.DB.prepare(
    "SELECT revisions.revision_number FROM drafts JOIN revisions ON revisions.id = drafts.latest_revision_id",
  ).all();
  expect(latestRevisions.results).toStrictEqual([{ revision_number: 2 }]);
});

function storageOn(database: D1Database, bindings: TestBindings): DraftsStorage {
  return {
    database: drizzleForSession(database, "first-primary").database,
    revisionBodies: bindings.REVISION_BODIES,
  };
}

async function readRows(database: D1Database) {
  const [drafts, revisions] = await database.batch([
    database.prepare("SELECT * FROM drafts ORDER BY id"),
    database.prepare("SELECT * FROM revisions ORDER BY draft_id, revision_number"),
  ]);
  return { drafts: drafts?.results, revisions: revisions?.results };
}
