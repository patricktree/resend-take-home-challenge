/*
 * Races between a Send attempt that Resend accepts and the paths that record `FAILED` /
 * `OUTCOME_UNKNOWN` without an answer from Resend: the deadline, the Send reconciler's backstop and
 * the DLQ consumer (spec section 9, "Recording outcomes"). The first final outcome wins, except
 * that a late `SENT` overrides `OUTCOME_UNKNOWN`.
 */

import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import type { SendQueueMessage } from "@resend-challenge/drafts";
import { resendError } from "@resend-challenge/resend-stub";

import { expectExactlyOneEmailPerSentDraft } from "#test/use-resend-stub.ts";
import {
  createApprovedDraft,
  getSending,
  readFailureColumns,
  useSendPipeline,
} from "#test/use-send-pipeline.ts";
import {
  deliverSendDlqBatch,
  deliverSendQueueBatch,
  readSendQueueCalls,
  runCronTick,
  type TestWorker,
} from "#test/use-worker.ts";

const HOUR_MILLISECONDS = 60 * 60 * 1000;

/** The paths that record `FAILED` / `OUTCOME_UNKNOWN` for a Send, each in one step. */
const OUTCOME_UNKNOWN_PATHS = [
  {
    name: "the deadline",
    recordOutcomeUnknown: async (worker: TestWorker, message: SendQueueMessage) => {
      const handlings = await deliverSendQueueBatch(worker, [
        { body: { ...message, deadline: Temporal.Now.instant().epochMilliseconds - 1000 } },
      ]);
      expectAcked(handlings);
    },
  },
  {
    name: "the backstop",
    recordOutcomeUnknown: async (worker: TestWorker, message: SendQueueMessage) => {
      const env = await worker.getEnv();
      await env.DB.prepare("UPDATE drafts SET deadline = ?1 WHERE id = ?2")
        .bind(Temporal.Now.instant().epochMilliseconds - HOUR_MILLISECONDS - 1000, message.draftId)
        .run();
      await runCronTick(worker);
    },
  },
  {
    name: "the DLQ",
    recordOutcomeUnknown: async (worker: TestWorker, message: SendQueueMessage) => {
      expectAcked(await deliverSendDlqBatch(worker, [{ body: message, attempts: 101 }]));
    },
  },
];

test.for(OUTCOME_UNKNOWN_PATHS)(
  "late SENT ‖ FAILED / OUTCOME_UNKNOWN from $name: the Send that Resend accepted wins and its failure is cleared",
  async ({ recordOutcomeUnknown }, { expect, onTestFinished }) => {
    const { resendStub, worker } = await useSendPipeline({ onTestFinished });
    const { draft, message } = await createApprovedDraft(worker);
    const held = resendStub.holdNext();
    const delivery = deliverSendQueueBatch(worker, [{ body: message }]);
    await held.received;

    await recordOutcomeUnknown(worker, message);
    expect(await getSending(worker, draft.id)).toStrictEqual({
      status: "FAILED",
      failure: { reason: "OUTCOME_UNKNOWN" },
    });
    held.release();

    expect(await delivery).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
    expect(await getSending(worker, draft.id)).toStrictEqual({
      status: "SENT",
      emailId: resendStub.emails[0]?.id,
    });
    expect(await readFailureColumns(worker, draft.id)).toStrictEqual({
      failure_reason: null,
      resend_error_name: null,
      resend_error_message: null,
    });
    await expectExactlyOneEmailPerSentDraft(worker, resendStub);
  },
);

test.for(OUTCOME_UNKNOWN_PATHS)(
  "late refusal ‖ FAILED / OUTCOME_UNKNOWN from $name: Resend refusing the attempt in flight never overrides OUTCOME_UNKNOWN",
  async ({ recordOutcomeUnknown }, { expect, onTestFinished }) => {
    const { resendStub, worker } = await useSendPipeline({ onTestFinished });
    const { draft, message } = await createApprovedDraft(worker);
    const held = resendStub.holdNext(resendError(422, "validation_error", "Invalid."));
    const delivery = deliverSendQueueBatch(worker, [{ body: message }]);
    await held.received;

    await recordOutcomeUnknown(worker, message);
    held.release();

    expect(await delivery).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
    expect(await getSending(worker, draft.id)).toStrictEqual({
      status: "FAILED",
      failure: { reason: "OUTCOME_UNKNOWN" },
    });
    await expectExactlyOneEmailPerSentDraft(worker, resendStub);
  },
);

test.for(OUTCOME_UNKNOWN_PATHS)(
  "FAILED / OUTCOME_UNKNOWN from $name never overrides SENT",
  async ({ recordOutcomeUnknown }, { expect, onTestFinished }) => {
    const { resendStub, worker } = await useSendPipeline({ onTestFinished });
    const { draft, message } = await createApprovedDraft(worker);
    await deliverSendQueueBatch(worker, [{ body: message }]);
    const sent = await getSending(worker, draft.id);
    expect(sent).toMatchObject({ status: "SENT" });

    await recordOutcomeUnknown(worker, message);

    expect(await getSending(worker, draft.id)).toStrictEqual(sent);
    await expectExactlyOneEmailPerSentDraft(worker, resendStub);
  },
);

test.for(OUTCOME_UNKNOWN_PATHS)(
  "FAILED / OUTCOME_UNKNOWN from $name never overrides FAILED / REJECTED_BY_RESEND",
  async ({ recordOutcomeUnknown }, { expect, onTestFinished }) => {
    const { resendStub, worker } = await useSendPipeline({ onTestFinished });
    const { draft, message } = await createApprovedDraft(worker);
    resendStub.respondNext(resendError(422, "validation_error", "Invalid `to` field."));
    await deliverSendQueueBatch(worker, [{ body: message }]);
    const rejected = await getSending(worker, draft.id);
    expect(rejected).toMatchObject({ failure: { reason: "REJECTED_BY_RESEND" } });

    await recordOutcomeUnknown(worker, message);

    expect(await getSending(worker, draft.id)).toStrictEqual(rejected);
    await expectExactlyOneEmailPerSentDraft(worker, resendStub);
  },
);

test("the reconciler never re-enqueues a Send that has ended, even without a recorded hand-off", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  await deliverSendQueueBatch(worker, [{ body: message }]);
  const sent = await getSending(worker, draft.id);
  const env = await worker.getEnv();
  await env.DB.prepare("UPDATE drafts SET enqueued_at = NULL, approved_at = ?1 WHERE id = ?2")
    .bind(Temporal.Now.instant().epochMilliseconds - HOUR_MILLISECONDS, draft.id)
    .run();

  await runCronTick(worker);

  expect(await readSendQueueCalls(worker)).toHaveLength(1);
  expect(await getSending(worker, draft.id)).toStrictEqual(sent);
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

function expectAcked(handlings: Awaited<ReturnType<typeof deliverSendQueueBatch>>): void {
  if (handlings.some(({ outcome }) => outcome !== "ACK")) {
    throw new Error(`Not every message was acked: ${JSON.stringify(handlings)}`);
  }
}
