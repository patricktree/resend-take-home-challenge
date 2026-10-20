import { test } from "vitest";

import { expectExactlyOneEmailPerSentDraft } from "#test/use-resend-stub.ts";
import { createApprovedDraft, getSending, useSendPipeline } from "#test/use-send-pipeline.ts";
import { deliverSendDlqBatch } from "#test/use-worker.ts";

test("a message in the dead-letter queue makes its Send FAILED / OUTCOME_UNKNOWN without calling Resend, and is acked", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);

  const handlings = await deliverSendDlqBatch(worker, [{ body: message, attempts: 101 }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(resendStub.requests).toStrictEqual([]);
  expect(await getSending(worker, draft.id)).toStrictEqual({
    status: "FAILED",
    failure: { reason: "OUTCOME_UNKNOWN" },
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a message in the dead-letter queue that is not a Send intent is acked and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft } = await createApprovedDraft(worker);

  const handlings = await deliverSendDlqBatch(worker, [{ body: { draftId: draft.id } }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});
