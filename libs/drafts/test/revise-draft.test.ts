import { test } from "vitest";

import { approveRevision } from "../src/review/approve-revision.ts";
import { createDraft } from "../src/review/create-draft.ts";
import { reviseDraft } from "../src/review/revise-draft.ts";
import { submitRevision } from "../src/review/submit-revision.ts";
import { drizzleForSession, type DraftsStorage } from "../src/storage/database.ts";
import { createHoldingD1Database } from "./holding-d1-database.ts";
import { createRecordingSendQueue } from "./recording-send-queue.ts";
import { useBindings, type TestBindings } from "./use-bindings.ts";

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
  const holdingDatabase = createHoldingD1Database(bindings.DB);
  const created = await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);
  const baseRevisionId = created.latestRevision.id;

  const hold = holdingDatabase.holdNext((call) => call.kind === "batch");
  const heldRevise = reviseDraft(storageOn(holdingDatabase.database, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Held revise",
    baseRevisionId,
  });
  await hold.reached;
  const committedRevise = await reviseDraft(storageOn(bindings.DB, bindings), created.id, {
    ...DRAFT_DATA,
    subject: "Committed revise",
    baseRevisionId,
  });
  const rowsAfterCommittedRevise = await readRows(bindings.DB);
  hold.release();
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

test("approve ‖ revise, approve first: the revise gets DRAFT_APPROVED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const holdingDatabase = createHoldingD1Database(bindings.DB);
  const storage = storageOn(bindings.DB, bindings);
  const created = await createDraft(storage, DRAFT_DATA);
  await submitRevision(storage, created.id, created.latestRevision.id);

  const hold = holdingDatabase.holdNext((call) => call.kind === "batch");
  const heldRevise = reviseDraft(storageOn(holdingDatabase.database, bindings), created.id, {
    ...DRAFT_DATA,
    baseRevisionId: created.latestRevision.id,
  });
  await hold.reached;
  const committedApproval = await approveRevision(
    storage,
    { sendQueue: createRecordingSendQueue(), from: "drafts@resend-challenge.patricktree.me" },
    created.id,
    created.latestRevision.id,
  );
  const rowsOfApprovedDraft = await readRows(bindings.DB);
  hold.release();

  expect(committedApproval).toMatchObject({ outcome: "APPROVED" });
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
