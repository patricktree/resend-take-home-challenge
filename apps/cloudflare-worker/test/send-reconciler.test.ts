import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import { expectExactlyOneEmailPerSentDraft } from "./use-resend-stub.ts";
import { createApprovedDraft, getSending, useSendPipeline } from "./use-send-pipeline.ts";
import {
  deliverSendQueueBatch,
  readSendQueueCalls,
  runCronTick,
  type TestWorker,
} from "./use-worker.ts";

const SECOND_MILLISECONDS = 1000;

const MINUTE_MILLISECONDS = 60 * SECOND_MILLISECONDS;

const HOUR_MILLISECONDS = 60 * MINUTE_MILLISECONDS;

/**
 * The Draft data whose Send Queue message is largest: 50 recipients of 254 characters and a subject
 * of 998 emoji. Its message is about 17 KB, so 20 of them exceed the 256 KB of one `sendBatch()`.
 */
const LARGEST_DRAFT_DATA = {
  to: Array.from(
    { length: 50 },
    (_, index) => `${String(index).padStart(64, "a")}@${"b".repeat(177)}.example.com`,
  ),
  subject: "📧".repeat(998),
  body: { plainText: "Hello" },
};

test("a tick re-enqueues a lost hand-off with one sendBatch of its frozen Send intent and records the hand-off", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  await loseHandOff(worker, draft.id, 61 * SECOND_MILLISECONDS);

  const tickStart = Temporal.Now.instant().epochMilliseconds;
  await runCronTick(worker);

  expect((await readSendQueueCalls(worker)).slice(1)).toStrictEqual([
    { method: "sendBatch", messages: [message] },
  ]);
  const { enqueued_at: enqueuedAt } = await readSendColumns(worker, draft.id);
  expect(enqueuedAt).toBeGreaterThanOrEqual(tickStart);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });

  // The next tick leaves the recorded hand-off alone, and the message sends the email.
  await runCronTick(worker);
  expect(await readSendQueueCalls(worker)).toHaveLength(2);
  await deliverSendQueueBatch(worker, [{ body: message }]);
  expect(await getSending(worker, draft.id)).toMatchObject({ status: "SENT" });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a tick re-enqueues the lost hand-offs of the largest Drafts through the real Send Queue in several sendBatch calls, and records every hand-off", async ({
  expect,
  onTestFinished,
}) => {
  const { worker } = await useSendPipeline({ onTestFinished });
  const approved = [];
  for (let index = 0; index < 20; index++) {
    approved.push(await createApprovedDraft(worker, LARGEST_DRAFT_DATA));
  }
  for (const { draft } of approved) {
    await loseHandOff(worker, draft.id, 61 * SECOND_MILLISECONDS);
  }

  await runCronTick(worker);

  const reenqueueCalls = (await readSendQueueCalls(worker)).slice(approved.length);
  expect(reenqueueCalls.length).toBeGreaterThan(1);
  expect(reenqueueCalls.map(({ method }) => method)).toStrictEqual(
    reenqueueCalls.map(() => "sendBatch"),
  );
  expect(reenqueueCalls.flatMap(({ messages }) => messages).toSorted(byDraftId)).toStrictEqual(
    approved.map(({ message }) => message).toSorted(byDraftId),
  );
  for (const { draft } of approved) {
    expect(await readSendColumns(worker, draft.id)).toMatchObject({
      enqueued_at: expect.any(Number),
    });
  }
});

test("a lost hand-off approved 59 s ago is left to the Approval's request, one approved 61 s ago is re-enqueued, and a recorded hand-off never is", async ({
  expect,
  onTestFinished,
}) => {
  const { worker } = await useSendPipeline({ onTestFinished });
  const recent = await createApprovedDraft(worker);
  const lost = await createApprovedDraft(worker);
  const handedOff = await createApprovedDraft(worker);
  await loseHandOff(worker, recent.draft.id, 59 * SECOND_MILLISECONDS);
  await loseHandOff(worker, lost.draft.id, 61 * SECOND_MILLISECONDS);
  await backdate(worker, handedOff.draft.id, { approvedAgoMilliseconds: 60 * MINUTE_MILLISECONDS });

  await runCronTick(worker);

  expect((await readSendQueueCalls(worker)).slice(3)).toStrictEqual([
    { method: "sendBatch", messages: [lost.message] },
  ]);
  expect(await readSendColumns(worker, recent.draft.id)).toMatchObject({ enqueued_at: null });
});

test("the backstop records FAILED / OUTCOME_UNKNOWN for a Send still QUEUED at deadline + 1 h, and leaves one just before it alone", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const expired = await createApprovedDraft(worker);
  const nearlyExpired = await createApprovedDraft(worker);
  await backdate(worker, expired.draft.id, {
    deadlineAgoMilliseconds: HOUR_MILLISECONDS + SECOND_MILLISECONDS,
  });
  await backdate(worker, nearlyExpired.draft.id, {
    deadlineAgoMilliseconds: HOUR_MILLISECONDS - MINUTE_MILLISECONDS,
  });

  await runCronTick(worker);

  expect(await getSending(worker, expired.draft.id)).toStrictEqual({
    status: "FAILED",
    failure: { reason: "OUTCOME_UNKNOWN" },
  });
  expect(await getSending(worker, nearlyExpired.draft.id)).toStrictEqual({ status: "QUEUED" });
  expect(resendStub.requests).toStrictEqual([]);
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("reconciler re-enqueue ‖ consumer: the re-enqueued message and the original overlap at Resend, and one email goes out", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message: originalMessage } = await createApprovedDraft(worker);
  // As if the Approval's request had died between sending the message and setting `enqueued_at`.
  await loseHandOff(worker, draft.id, 61 * SECOND_MILLISECONDS);
  await runCronTick(worker);
  const reenqueuedMessage = (await readSendQueueCalls(worker))[1]?.messages[0];
  expect(reenqueuedMessage).toStrictEqual(originalMessage);

  const held = resendStub.holdNext();
  const originalDelivery = deliverSendQueueBatch(worker, [
    { id: "original", body: originalMessage },
  ]);
  await held.received;
  const reenqueuedDelivery = await deliverSendQueueBatch(worker, [
    { id: "reenqueued", body: reenqueuedMessage },
  ]);
  held.release();

  expect(reenqueuedDelivery).toStrictEqual([
    { id: "reenqueued", outcome: "RETRY", delaySeconds: expect.any(Number) },
  ]);
  expect(await originalDelivery).toStrictEqual([{ id: "original", outcome: "ACK" }]);
  const sent = await getSending(worker, draft.id);
  expect(sent).toStrictEqual({ status: "SENT", emailId: resendStub.emails[0]?.id });

  // The retried re-enqueued message finds the Send ended and never reaches Resend.
  const retriedDelivery = await deliverSendQueueBatch(worker, [
    { id: "reenqueued", body: reenqueuedMessage, attempts: 2 },
  ]);

  expect(retriedDelivery).toStrictEqual([{ id: "reenqueued", outcome: "ACK" }]);
  expect(await getSending(worker, draft.id)).toStrictEqual(sent);
  expect(resendStub.requests).toHaveLength(2);
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

function byDraftId(first: { draftId: string }, second: { draftId: string }): number {
  return first.draftId.localeCompare(second.draftId);
}

/**
 * Makes the Draft's Send a lost hand-off, approved `approvedAgoMilliseconds` ago: as if the
 * Approval's request had died before its Queue message was sent or before `enqueued_at` was set.
 */
async function loseHandOff(
  worker: TestWorker,
  draftId: string,
  approvedAgoMilliseconds: number,
): Promise<void> {
  const env = await worker.getEnv();
  await env.DB.prepare("UPDATE drafts SET enqueued_at = NULL, approved_at = ?1 WHERE id = ?2")
    .bind(Temporal.Now.instant().epochMilliseconds - approvedAgoMilliseconds, draftId)
    .run();
}

/**
 * Moves the Draft's Approval or its deadline into the past, keeping its recorded hand-off: sets
 * `approved_at` to `approvedAgoMilliseconds` ago, `deadline` to `deadlineAgoMilliseconds` ago.
 */
async function backdate(
  worker: TestWorker,
  draftId: string,
  {
    approvedAgoMilliseconds,
    deadlineAgoMilliseconds,
  }: { approvedAgoMilliseconds?: number; deadlineAgoMilliseconds?: number },
): Promise<void> {
  const env = await worker.getEnv();
  const now = Temporal.Now.instant().epochMilliseconds;
  await env.DB.prepare(
    "UPDATE drafts SET approved_at = coalesce(?1, approved_at), deadline = coalesce(?2, deadline) WHERE id = ?3",
  )
    .bind(
      approvedAgoMilliseconds === undefined ? null : now - approvedAgoMilliseconds,
      deadlineAgoMilliseconds === undefined ? null : now - deadlineAgoMilliseconds,
      draftId,
    )
    .run();
}

async function readSendColumns(worker: TestWorker, draftId: string) {
  const env = await worker.getEnv();
  const row = await env.DB.prepare(
    "SELECT sending_status, approved_at, enqueued_at, deadline FROM drafts WHERE id = ?",
  )
    .bind(draftId)
    .first<{
      sending_status: string;
      approved_at: number;
      enqueued_at: number | null;
      deadline: number;
    }>();
  if (row === null) {
    throw new Error(`Draft ${draftId} has no row.`);
  }
  return row;
}
