import { Temporal } from "temporal-polyfill";
import { test, vi } from "vitest";

import { approveRevision } from "#src/approve-revision.ts";
import { createDraft } from "#src/create-draft.ts";
import { drizzleForSession, type DraftsStorage } from "#src/database.ts";
import type { DraftId } from "#src/ids.ts";
import { reconcileSends } from "#src/send-reconciler.ts";
import { submitRevision } from "#src/submit-revision.ts";

import { createGatedD1Database } from "#test/gated-d1-database.ts";
import { createFailingSendQueue, createRecordingSendQueue } from "#test/recording-send-queue.ts";
import { useBindings, type TestBindings } from "#test/use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

const RESEND_FROM = "drafts@resend-challenge.patricktree.me";

const SECOND_MILLISECONDS = 1000;

const HOUR_MILLISECONDS = 60 * 60 * SECOND_MILLISECONDS;

test("a tick re-enqueues at most 100 lost hand-offs, the oldest Approvals first, with one sendBatch; the next tick re-enqueues the rest", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const draftIds = await createApprovedDrafts(bindings, 101, { isHandOffLost: true });
  // Approved in the reverse order of their ids, so that "oldest first" is not "lowest id first".
  const now = Temporal.Now.instant().epochMilliseconds;
  await updateEachDraft(bindings.DB, draftIds, "approved_at", (index) => {
    return now - HOUR_MILLISECONDS - index * SECOND_MILLISECONDS;
  });
  const draftIdsOldestFirst = draftIds.toReversed();
  const sendQueue = createRecordingSendQueue();

  await reconcileSends({ database: databaseOn(bindings.DB), sendQueue });

  expect(sendQueue.sentBatches.map((batch) => batch.map(({ draftId }) => draftId))).toStrictEqual([
    draftIdsOldestFirst.slice(0, 100),
  ]);
  expect(await readEnqueuedDraftIds(bindings.DB)).toStrictEqual(
    draftIdsOldestFirst.slice(0, 100).toSorted(),
  );

  await reconcileSends({ database: databaseOn(bindings.DB), sendQueue });

  expect(sendQueue.sentBatches.map((batch) => batch.map(({ draftId }) => draftId))).toStrictEqual([
    draftIdsOldestFirst.slice(0, 100),
    draftIdsOldestFirst.slice(100),
  ]);
  expect(await readEnqueuedDraftIds(bindings.DB)).toStrictEqual(draftIds.toSorted());
});

test("the backstop resolves at most 100 Sends per tick, the earliest deadlines first", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const draftIds = await createApprovedDrafts(bindings, 101, { isHandOffLost: false });
  // Deadlines in the reverse order of their ids, so that "earliest first" is not "lowest id first".
  const now = Temporal.Now.instant().epochMilliseconds;
  await updateEachDraft(bindings.DB, draftIds, "deadline", (index) => {
    return now - 2 * HOUR_MILLISECONDS - index * SECOND_MILLISECONDS;
  });
  const sendQueue = createRecordingSendQueue();

  await reconcileSends({ database: databaseOn(bindings.DB), sendQueue });

  const [latestDeadlineDraftId] = draftIds;
  expect(await readSendingStatuses(bindings.DB)).toStrictEqual(
    Object.fromEntries(
      draftIds.map((draftId) => [
        draftId,
        draftId === latestDeadlineDraftId ? "QUEUED" : "FAILED/OUTCOME_UNKNOWN",
      ]),
    ),
  );
  expect(sendQueue.sentBatches).toStrictEqual([]);
});

test("a failed sendBatch stops re-enqueueing for this tick: no hand-off is recorded, the root cause is logged, the backstop still runs, and a later tick drains the backlog", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const [lostDraftId, expiredDraftId] = await createApprovedDrafts(bindings, 2, {
    isHandOffLost: true,
  });
  if (lostDraftId === undefined || expiredDraftId === undefined) {
    throw new Error("createApprovedDrafts() created fewer than two Drafts.");
  }
  const now = Temporal.Now.instant().epochMilliseconds;
  await bindings.DB.batch([
    bindings.DB.prepare("UPDATE drafts SET approved_at = ?1 WHERE id = ?2").bind(
      now - 2 * 60 * SECOND_MILLISECONDS,
      lostDraftId,
    ),
    // Recorded as handed off, so only the backstop takes it.
    bindings.DB.prepare("UPDATE drafts SET enqueued_at = ?1, deadline = ?2 WHERE id = ?3").bind(
      now,
      now - 2 * HOUR_MILLISECONDS,
      expiredDraftId,
    ),
  ]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => consoleError.mockRestore());
  const failingSendQueue = createFailingSendQueue({
    rootCauseMessage: "Queue unavailable",
    wrapperMessage: "Wrapped with secret parameters",
  });

  await reconcileSends({ database: databaseOn(bindings.DB), sendQueue: failingSendQueue });

  expect(await readEnqueuedDraftIds(bindings.DB)).toStrictEqual([expiredDraftId]);
  expect(await readSendingStatuses(bindings.DB)).toStrictEqual({
    [lostDraftId]: "QUEUED",
    [expiredDraftId]: "FAILED/OUTCOME_UNKNOWN",
  });
  expect(consoleError).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Queue unavailable"),
  );
  // Only the root cause is logged, never a wrapping error's message.
  expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("secret parameters"));

  const sendQueue = createRecordingSendQueue();
  await reconcileSends({ database: databaseOn(bindings.DB), sendQueue });

  expect(sendQueue.sentBatches).toMatchObject([[{ draftId: lostDraftId }]]);
  expect((await readEnqueuedDraftIds(bindings.DB)).toSorted()).toStrictEqual(
    [lostDraftId, expiredDraftId].toSorted(),
  );
});

test.for([
  {
    job: "lost hand-off",
    indexName: "drafts_queued_not_enqueued_approved_at_index",
    isJobQuery: (query: string) => query.includes(`"enqueued_at" is null`),
  },
  {
    job: "backstop",
    indexName: "drafts_queued_deadline_index",
    isJobQuery: (query: string) => query.includes(`"deadline" <`),
  },
])(
  "the $job job's query walks $indexName in order, without sorting",
  async ({ indexName, isJobQuery }, { expect, onTestFinished }) => {
    const bindings = await useBindings({ onTestFinished });
    const gatedDatabase = createGatedD1Database(bindings.DB);
    const gate = gatedDatabase.holdNext(
      (call) =>
        call.kind === "statement" && call.query.startsWith("select") && isJobQuery(call.query),
    );

    const tick = reconcileSends({
      database: databaseOn(gatedDatabase.database),
      sendQueue: createRecordingSendQueue(),
    });
    const call = await gate.reached;
    gate.release();
    await tick;

    if (call.kind !== "statement") {
      throw new Error("The job ran a batch instead of one statement.");
    }
    const plan = await explainQueryPlan(bindings.DB, call.query);
    expect(plan).toStrictEqual([
      expect.stringMatching(new RegExp(`^SEARCH drafts USING INDEX ${indexName} \\(`)),
    ]);
  },
);

/**
 * Creates `count` Drafts and approves each, one after the other, so their ids sort in creation
 * order. With `isHandOffLost`, each Send is a lost hand-off: `enqueued_at` is unset, as if the
 * Approval's request had died before recording its hand-off to the Send Queue.
 */
async function createApprovedDrafts(
  bindings: TestBindings,
  count: number,
  { isHandOffLost }: { isHandOffLost: boolean },
): Promise<DraftId[]> {
  const storage: DraftsStorage = {
    database: databaseOn(bindings.DB),
    revisionBodies: bindings.REVISION_BODIES,
  };
  const sendHandOff = { sendQueue: createRecordingSendQueue(), from: RESEND_FROM };

  const draftIds: DraftId[] = [];
  for (let index = 0; index < count; index++) {
    const created = await createDraft(storage, DRAFT_DATA);
    await submitRevision(storage, created.id, created.latestRevision.id);
    const approved = await approveRevision(
      storage,
      sendHandOff,
      created.id,
      created.latestRevision.id,
    );
    if (approved.outcome !== "APPROVED") {
      throw new Error(`The Approval ended with ${approved.outcome}.`);
    }
    draftIds.push(created.id);
  }

  if (isHandOffLost) {
    await bindings.DB.prepare("UPDATE drafts SET enqueued_at = NULL").run();
  }
  return draftIds;
}

/** Sets `column` of each Draft to `valueAt(index)`, in one batch. */
async function updateEachDraft(
  database: D1Database,
  draftIds: DraftId[],
  column: "approved_at" | "deadline",
  valueAt: (index: number) => number,
): Promise<void> {
  await database.batch(
    draftIds.map((draftId, index) =>
      database
        .prepare(`UPDATE drafts SET ${column} = ?1 WHERE id = ?2`)
        .bind(valueAt(index), draftId),
    ),
  );
}

async function readEnqueuedDraftIds(database: D1Database): Promise<string[]> {
  const { results } = await database
    .prepare("SELECT id FROM drafts WHERE enqueued_at IS NOT NULL ORDER BY id")
    .all<{ id: string }>();
  return results.map(({ id }) => id);
}

/** Each Draft's sending status, with the failure reason when `FAILED`. */
async function readSendingStatuses(database: D1Database): Promise<Record<string, string>> {
  const { results } = await database
    .prepare("SELECT id, sending_status, failure_reason FROM drafts ORDER BY id")
    .all<{ id: string; sending_status: string; failure_reason: string | null }>();
  return Object.fromEntries(
    results.map(({ id, sending_status: sendingStatus, failure_reason: failureReason }) => [
      id,
      failureReason === null ? sendingStatus : `${sendingStatus}/${failureReason}`,
    ]),
  );
}

/** The details of the query's plan; the plan does not depend on the values, so all are `NULL`. */
async function explainQueryPlan(database: D1Database, query: string): Promise<string[]> {
  const parameterCount = query.match(/\?/g)?.length ?? 0;
  const { results } = await database
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...Array.from({ length: parameterCount }, () => null))
    .all<{ detail: string }>();
  return results.map((row) => row.detail);
}

function databaseOn(database: D1Database) {
  return drizzleForSession(database, "first-primary").database;
}
