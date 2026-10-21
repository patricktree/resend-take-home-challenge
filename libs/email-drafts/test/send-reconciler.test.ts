import { Temporal } from "temporal-polyfill";
import { test, vi } from "vitest";

import type { DraftData, OutgoingEmail } from "../src/domain/draft.ts";
import { createDraftId, createRevisionId, type DraftId } from "../src/domain/ids.ts";
import { computeSendDeadline } from "../src/domain/send-deadline.ts";
import { approveRevision } from "../src/review/approve-revision.ts";
import { createDraft } from "../src/review/create-draft.ts";
import { submitRevision } from "../src/review/submit-revision.ts";
import type { SendQueue } from "../src/send/send-queue.ts";
import { reconcileSends } from "../src/send/send-reconciler.ts";
import { drizzleForSession, type DraftsStorage } from "../src/storage/database.ts";
import { revisionBodyKey } from "../src/storage/revision-bodies.ts";
import { drafts, revisions } from "../src/storage/schema.ts";
import { createHoldingD1Database } from "./holding-d1-database.ts";
import { createFailingSendQueue, createRecordingSendQueue } from "./recording-send-queue.ts";
import { useBindings, type TestBindings } from "./use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

/**
 * Draft data at the limits that make a Send Queue message largest: 50 recipients of 254 characters
 * and a subject of 998 emoji, 4 bytes each in UTF-8. Its message is about 17 KB, so 20 of them
 * exceed the 256 KB of one `sendBatch()`.
 */
const LARGEST_DRAFT_DATA = {
  to: Array.from(
    { length: 50 },
    (_, index) => `${String(index).padStart(64, "a")}@${"b".repeat(177)}.example.com`,
  ),
  subject: "📧".repeat(998),
  body: { plainText: "Hello" },
};

const RESEND_FROM = "drafts@resend-challenge.patricktree.me";

const SECOND_MILLISECONDS = 1000;

const HOUR_MILLISECONDS = 60 * 60 * SECOND_MILLISECONDS;

/** The columns that hold a timestamp, whose values differ between any two Drafts. */
const TIMESTAMP_COLUMNS = new Set([
  "created_at",
  "last_action_at",
  "approved_at",
  "deadline",
  "enqueued_at",
  "submitted_at",
  "decided_at",
]);

test.for([
  { draftDataName: "small", draftData: DRAFT_DATA, isHandOffLost: false },
  { draftDataName: "largest", draftData: LARGEST_DRAFT_DATA, isHandOffLost: true },
])(
  "a seeded approved Draft has the rows a real Approval writes ($draftDataName Draft data, isHandOffLost $isHandOffLost)",
  async ({ draftData, isHandOffLost }, { expect, onTestFinished }) => {
    const bindings = await useBindings({ onTestFinished });
    // The real one first: `createApprovedDrafts()` loses the hand-off of every Draft in the table.
    const [approvedDraftId] = await createApprovedDrafts(bindings, 1, { isHandOffLost, draftData });
    const [seededDraftId] = await seedApprovedDrafts(bindings.DB, 1, { isHandOffLost, draftData });
    if (approvedDraftId === undefined || seededDraftId === undefined) {
      throw new Error("A fixture created no Draft.");
    }

    expect(await readRowShapes(bindings.DB, seededDraftId)).toStrictEqual(
      await readRowShapes(bindings.DB, approvedDraftId),
    );
  },
);

test("a tick re-enqueues at most 100 lost hand-offs, the oldest Approvals first, with one sendBatch; the next tick re-enqueues the rest", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const draftIds = await seedApprovedDrafts(bindings.DB, 101, { isHandOffLost: true });
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

test("a tick re-enqueues large lost hand-offs in several sendBatch calls, each within the Queues limits of 100 messages and 256 KB, the oldest Approvals first", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const draftIds = await seedApprovedDrafts(bindings.DB, 20, {
    isHandOffLost: true,
    draftData: LARGEST_DRAFT_DATA,
  });
  const now = Temporal.Now.instant().epochMilliseconds;
  await updateEachDraft(bindings.DB, draftIds, "approved_at", (index) => {
    return now - HOUR_MILLISECONDS - index * SECOND_MILLISECONDS;
  });
  const sendQueue = createRecordingSendQueue();

  await reconcileSends({ database: databaseOn(bindings.DB), sendQueue });

  // The recording double refuses every sendBatch() over the limits, as Cloudflare Queues does.
  expect(sendQueue.sentBatches.length).toBeGreaterThan(1);
  expect(sendQueue.sentBatches.flat().map(({ draftId }) => draftId)).toStrictEqual(
    draftIds.toReversed(),
  );
  expect(await readEnqueuedDraftIds(bindings.DB)).toStrictEqual(draftIds.toSorted());
});

test("a failed sendBatch of one chunk stops the job: the chunks before it are recorded as handed off, the rest are re-enqueued by a later tick", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const draftIds = await seedApprovedDrafts(bindings.DB, 20, {
    isHandOffLost: true,
    draftData: LARGEST_DRAFT_DATA,
  });
  const now = Temporal.Now.instant().epochMilliseconds;
  await updateEachDraft(bindings.DB, draftIds, "approved_at", (index) => {
    return now - HOUR_MILLISECONDS - index * SECOND_MILLISECONDS;
  });
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => consoleError.mockRestore());
  const recordingSendQueue = createRecordingSendQueue();
  let sendBatchCalls = 0;
  const secondChunkFailingSendQueue: SendQueue = {
    send: (message) => recordingSendQueue.send(message),
    sendBatch: async (messageRequests) => {
      sendBatchCalls++;
      if (sendBatchCalls === 2) {
        throw new Error("Queue unavailable");
      }
      return recordingSendQueue.sendBatch(messageRequests);
    },
  };

  await reconcileSends({
    database: databaseOn(bindings.DB),
    sendQueue: secondChunkFailingSendQueue,
  });

  expect(sendBatchCalls).toBe(2);
  const [firstChunk] = recordingSendQueue.sentBatches;
  const firstChunkDraftIds = (firstChunk ?? []).map(({ draftId }) => draftId);
  expect(firstChunkDraftIds).toStrictEqual(
    draftIds.toReversed().slice(0, firstChunkDraftIds.length),
  );
  expect(await readEnqueuedDraftIds(bindings.DB)).toStrictEqual(firstChunkDraftIds.toSorted());
  expect(consoleError).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("Queue unavailable"),
  );

  const sendQueue = createRecordingSendQueue();
  await reconcileSends({ database: databaseOn(bindings.DB), sendQueue });

  expect(sendQueue.sentBatches.flat().map(({ draftId }) => draftId)).toStrictEqual(
    draftIds.toReversed().slice(firstChunkDraftIds.length),
  );
  expect(await readEnqueuedDraftIds(bindings.DB)).toStrictEqual(draftIds.toSorted());
});

test("the backstop resolves at most 100 Sends per tick, the earliest deadlines first", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const draftIds = await seedApprovedDrafts(bindings.DB, 101, { isHandOffLost: false });
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

test("re-enqueue ‖ the Approval recording its hand-off, or the Send ending: the reconciler's hand-off write changes neither row", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const [lateHandOffDraftId, endedDraftId] = await createApprovedDrafts(bindings, 2, {
    isHandOffLost: true,
  });
  if (lateHandOffDraftId === undefined || endedDraftId === undefined) {
    throw new Error("createApprovedDrafts() created fewer than two Drafts.");
  }
  const now = Temporal.Now.instant().epochMilliseconds;
  await bindings.DB.prepare("UPDATE drafts SET approved_at = ?1")
    .bind(now - HOUR_MILLISECONDS)
    .run();
  const holdingDatabase = createHoldingD1Database(bindings.DB);
  const sendQueue = createRecordingSendQueue();

  const hold = holdingDatabase.holdNext((call) => call.kind === "batch");
  const tick = reconcileSends({ database: databaseOn(holdingDatabase.database), sendQueue });
  await hold.reached;
  const lateHandOffAt = now - 30 * SECOND_MILLISECONDS;
  await bindings.DB.batch([
    // The Approval's request records its hand-off after all, late.
    bindings.DB.prepare("UPDATE drafts SET enqueued_at = ?1 WHERE id = ?2").bind(
      lateHandOffAt,
      lateHandOffDraftId,
    ),
    // The original message's delivery records SENT.
    bindings.DB.prepare(
      "UPDATE drafts SET sending_status = 'SENT', email_id = 'email-id' WHERE id = ?1",
    ).bind(endedDraftId),
  ]);
  hold.release();
  await tick;

  expect(sendQueue.sentBatches).toHaveLength(1);
  const { results } = await bindings.DB.prepare(
    "SELECT id, sending_status, enqueued_at FROM drafts",
  ).all();
  expect(
    Object.fromEntries(
      results.map((row) => [
        row["id"],
        { status: row["sending_status"], enqueuedAt: row["enqueued_at"] },
      ]),
    ),
  ).toStrictEqual({
    [lateHandOffDraftId]: { status: "QUEUED", enqueuedAt: lateHandOffAt },
    [endedDraftId]: { status: "SENT", enqueuedAt: null },
  });
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
    const holdingDatabase = createHoldingD1Database(bindings.DB);
    const hold = holdingDatabase.holdNext(
      (call) =>
        call.kind === "statement" && call.query.startsWith("select") && isJobQuery(call.query),
    );

    const tick = reconcileSends({
      database: databaseOn(holdingDatabase.database),
      sendQueue: createRecordingSendQueue(),
    });
    const call = await hold.reached;
    hold.release();
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
  { isHandOffLost, draftData = DRAFT_DATA }: { isHandOffLost: boolean; draftData?: DraftData },
): Promise<DraftId[]> {
  const storage: DraftsStorage = {
    database: databaseOn(bindings.DB),
    revisionBodies: bindings.REVISION_BODIES,
  };
  const sendHandOff = { sendQueue: createRecordingSendQueue(), from: RESEND_FROM };

  const draftIds: DraftId[] = [];
  for (let index = 0; index < count; index++) {
    const created = await createDraft(storage, draftData);
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

/**
 * Inserts `count` approved Drafts with one batch, as `createApprovedDrafts()` would create them,
 * but in one round trip instead of several per Draft: dozens of Drafts created one by one take long
 * enough to exceed the test timeout on a loaded machine. Their rows are those of a real Approval,
 * which the test "a seeded approved Draft has the rows a real Approval writes" pins. The Revision
 * bodies stay out of R2, since the Send reconciler never reads them.
 *
 * The ids are created one after the other, so they sort in creation order.
 */
async function seedApprovedDrafts(
  database: D1Database,
  count: number,
  { isHandOffLost, draftData = DRAFT_DATA }: { isHandOffLost: boolean; draftData?: DraftData },
): Promise<DraftId[]> {
  const drizzleDatabase = databaseOn(database);
  const approvedAt = Temporal.Now.instant();
  const now = approvedAt.epochMilliseconds;

  const draftIds: DraftId[] = [];
  const inserts = [];
  for (let index = 0; index < count; index++) {
    const draftId = createDraftId();
    const revisionId = createRevisionId();
    // In the key order of the Approval's `json_object()`, so that the stored JSON text is the same.
    const outgoingEmail: OutgoingEmail = {
      from: RESEND_FROM,
      to: draftData.to,
      subject: draftData.subject,
      bodyKey: revisionBodyKey(revisionId),
      tags: [{ name: "draft_id", value: draftId }],
    };
    const draftRow: typeof drafts.$inferSelect = {
      id: draftId,
      createdAt: now,
      lastActionAt: now,
      latestRevisionId: revisionId,
      sendingStatus: "QUEUED",
      approvedRevisionId: revisionId,
      approvedAt: now,
      idempotencyKey: `draft-send/${draftId}`,
      outgoingEmail,
      deadline: computeSendDeadline(approvedAt),
      enqueuedAt: isHandOffLost ? null : now,
      emailId: null,
      failureReason: null,
      resendErrorName: null,
      resendErrorMessage: null,
    };
    const revisionRow: typeof revisions.$inferSelect = {
      id: revisionId,
      draftId,
      revisionNumber: 1,
      createdAt: now,
      toAddresses: draftData.to,
      subject: draftData.subject,
      reviewStatus: "APPROVED",
      submittedAt: now,
      decidedAt: now,
      rejectionReason: null,
    };
    // The Draft row goes first: the Revision's foreign key references it.
    inserts.push(
      drizzleDatabase.insert(drafts).values(draftRow),
      drizzleDatabase.insert(revisions).values(revisionRow),
    );
    draftIds.push(draftId);
  }

  const [firstInsert, ...otherInserts] = inserts;
  if (firstInsert === undefined) {
    throw new Error("seedApprovedDrafts() needs a count of at least 1.");
  }
  await drizzleDatabase.batch([firstInsert, ...otherInserts]);
  return draftIds;
}

/**
 * The rows of a Draft and of its one Revision, made comparable across Drafts: the ids become
 * placeholders, wherever they occur, and each timestamp becomes whether it is set. The deadline
 * keeps its distance from the Approval.
 */
async function readRowShapes(
  database: D1Database,
  draftId: DraftId,
): Promise<{
  draft: Record<string, unknown>;
  deadlineAfterApproval: number;
  revision: Record<string, unknown>;
}> {
  const draftRow = await database
    .prepare("SELECT * FROM drafts WHERE id = ?1")
    .bind(draftId)
    .first();
  const revisionRow = await database
    .prepare("SELECT * FROM revisions WHERE draft_id = ?1")
    .bind(draftId)
    .first();
  if (draftRow === null || revisionRow === null) {
    throw new Error(`Draft ${draftId} or its Revision has no row.`);
  }
  const revisionId = String(revisionRow["id"]);

  const toShape = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => {
        if (TIMESTAMP_COLUMNS.has(column)) {
          return [column, value === null ? null : "<timestamp>"];
        }
        if (typeof value === "string") {
          return [
            column,
            value.replaceAll(draftId, "<draft id>").replaceAll(revisionId, "<revision id>"),
          ];
        }
        return [column, value];
      }),
    );
  return {
    draft: toShape(draftRow),
    deadlineAfterApproval: Number(draftRow["deadline"]) - Number(draftRow["approved_at"]),
    revision: toShape(revisionRow),
  };
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
