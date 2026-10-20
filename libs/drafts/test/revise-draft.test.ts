import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import { createDraft } from "#src/create-draft.ts";
import { drizzleForSession, type DraftsStorage } from "#src/database.ts";
import { reviseDraft } from "#src/revise-draft.ts";

import { createGatedD1Database } from "#test/gated-d1-database.ts";
import { useBindings, type TestBindings } from "#test/use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

test("revise ‖ revise on the same base: the revise whose batch commits second gets REVISION_SUPERSEDED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const created = await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);
  const baseRevisionId = created.latestRevision.id;

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldRevise = reviseDraft(storageOn(gatedDatabase.database, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Held revise",
    baseRevisionId,
  });
  await gate.reached;
  const committedRevise = await reviseDraft(storageOn(bindings.DB, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Committed revise",
    baseRevisionId,
  });
  const rowsAfterCommittedRevise = await readRows(bindings.DB);
  gate.release();
  const heldOutcome = await heldRevise;

  expect(committedRevise).toMatchObject({
    outcome: "REVISED",
    draft: { latestRevision: { revisionNumber: 2, subject: "Committed revise" } },
  });
  expect(heldOutcome).toStrictEqual({ outcome: "REVISION_SUPERSEDED" });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsAfterCommittedRevise);
  expect(rowsAfterCommittedRevise.revisions).toMatchObject([
    { revision_number: 1, review_status: "SUPERSEDED" },
    { revision_number: 2, review_status: "UNSUBMITTED", subject: "Committed revise" },
  ]);
});

test("a revise whose batch commits after an Approval gets DRAFT_APPROVED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const gatedDatabase = createGatedD1Database(bindings.DB);
  const created = await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldRevise = reviseDraft(storageOn(gatedDatabase.database, bindings), created.id, {
    ...DRAFT_DATA,
    baseRevisionId: created.latestRevision.id,
  });
  await gate.reached;
  await approveDirectly(bindings.DB, created.id, created.latestRevision.id);
  const rowsOfApprovedDraft = await readRows(bindings.DB);
  gate.release();

  expect(await heldRevise).toStrictEqual({ outcome: "DRAFT_APPROVED" });
  expect(await readRows(bindings.DB)).toStrictEqual(rowsOfApprovedDraft);
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

/** Approvals do not exist yet: puts the Draft into the approved state with a consistent outbox. */
async function approveDirectly(database: D1Database, draftId: string, revisionId: string) {
  const now = Temporal.Now.instant().epochMilliseconds;
  await database.batch([
    database
      .prepare(
        "UPDATE drafts SET sending_status = 'QUEUED', approved_revision_id = ?1, approved_at = ?2, idempotency_key = ?3, outgoing_email = '{}', deadline = ?4, last_action_at = ?2 WHERE id = ?5",
      )
      .bind(revisionId, now, `draft-send/${draftId}`, now + 23 * 60 * 60 * 1000, draftId),
    database
      .prepare(
        "UPDATE revisions SET review_status = 'APPROVED', submitted_at = ?1, decided_at = ?1 WHERE id = ?2",
      )
      .bind(now, revisionId),
  ]);
}
