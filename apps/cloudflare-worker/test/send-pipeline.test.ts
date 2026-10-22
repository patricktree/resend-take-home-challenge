import { Temporal } from "temporal-polyfill";
import { test, type TestContext } from "vitest";

import type { SendQueueMessage } from "@resend-challenge/email-drafts";
import { resendError, type ResendStub } from "@resend-challenge/resend-stub";

import {
  expectExactlyOneEmailPerSentDraft,
  resendStubWorkerOptions,
  TEST_RESEND_API_KEY,
  useResendStub,
} from "./use-resend-stub.ts";
import {
  createApprovedDraft,
  DRAFT_DATA,
  getDraft,
  getSending,
  useSendPipeline,
} from "./use-send-pipeline.ts";
import { deliverSendQueueBatch, useWorker, type TestWorker } from "./use-worker.ts";

/** `RESEND_FROM` of test/wrangler.test.jsonc. */
const RESEND_FROM = "drafts@resend-challenge.patricktree.me";

const HOUR_MILLISECONDS = 60 * 60 * 1000;

/** The discard port, where nothing listens. */
const UNREACHABLE_RESEND_BASE_URL = "http://127.0.0.1:9";

/** The first delivery's backoff: 1 s, plus up to 1 s of jitter, in whole seconds. */
const FIRST_RETRY_DELAY = { min: 1, max: 2 };

test("delivering an Approval's message sends the frozen email through Resend once, and the Draft becomes SENT with Resend's email id", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);

  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(resendStub.requests).toStrictEqual([
    {
      method: "POST",
      pathname: "/emails",
      authorization: `Bearer ${TEST_RESEND_API_KEY}`,
      idempotencyKey: `draft-send/${draft.id}`,
      body: {
        from: RESEND_FROM,
        to: DRAFT_DATA.to,
        subject: DRAFT_DATA.subject,
        text: DRAFT_DATA.body.plainText,
        tags: [{ name: "draft_id", value: draft.id }],
      },
    },
  ]);
  const emailId = resendStub.emails[0]?.id;
  expect(emailId).toEqual(expect.any(String));
  expect(await getDraft(worker, draft.id)).toStrictEqual({
    ...draft,
    latestRevision: { ...draft.latestRevision, body: DRAFT_DATA.body },
    sending: { status: "SENT", emailId },
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("an Approval's message reaches the Send Queue consumer through real Queue delivery, and the Draft becomes SENT", async ({
  expect,
  onTestFinished,
}) => {
  const resendStub = await useResendStub({ onTestFinished });
  const worker = await useWorker(
    { onTestFinished },
    { ...resendStubWorkerOptions(resendStub.url), shouldConsumeSendQueue: true },
  );

  const { draft } = await createApprovedDraft(worker);

  await expect
    .poll(() => getSending(worker, draft.id), { timeout: 15_000, interval: 200 })
    .toMatchObject({ status: "SENT" });
  expect(await getSending(worker, draft.id)).toStrictEqual({
    status: "SENT",
    emailId: resendStub.emails[0]?.id,
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test.for([
  {
    name: "SENT",
    endedSending: { status: "SENT" },
    endSend: async (worker: TestWorker, _stub: ResendStub, message: SendQueueMessage) => {
      await deliverSendQueueBatch(worker, [{ body: message }]);
    },
  },
  {
    name: "FAILED / REJECTED_BY_RESEND",
    endedSending: { status: "FAILED", failure: { reason: "REJECTED_BY_RESEND" } },
    endSend: async (worker: TestWorker, stub: ResendStub, message: SendQueueMessage) => {
      stub.respondNext(resendError(422, "validation_error", "Invalid `to` field."));
      await deliverSendQueueBatch(worker, [{ body: message }]);
    },
  },
  {
    name: "FAILED / OUTCOME_UNKNOWN",
    endedSending: { status: "FAILED", failure: { reason: "OUTCOME_UNKNOWN" } },
    endSend: async (worker: TestWorker, _stub: ResendStub, message: SendQueueMessage) => {
      await deliverSendQueueBatch(worker, [
        { body: { ...message, deadline: Temporal.Now.instant().epochMilliseconds - 1000 } },
      ]);
    },
  },
])(
  "a duplicate message for a Send that ended $name is acked without calling Resend, and the Send keeps its outcome",
  async ({ endedSending, endSend }, { expect, onTestFinished }) => {
    const { resendStub, worker } = await useSendPipeline({ onTestFinished });
    const { draft, message } = await createApprovedDraft(worker);
    await endSend(worker, resendStub, message);
    const ended = await getSending(worker, draft.id);
    expect(ended).toMatchObject(endedSending);
    const resendRequestCount = resendStub.requests.length;

    const handlings = await deliverSendQueueBatch(worker, [{ body: message, attempts: 2 }]);

    expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
    expect(resendStub.requests).toHaveLength(resendRequestCount);
    expect(await getSending(worker, draft.id)).toStrictEqual(ended);
    await expectExactlyOneEmailPerSentDraft(worker, resendStub);
  },
);

test("a 422 from Resend is final: the Draft becomes FAILED / REJECTED_BY_RESEND with Resend's error name and message", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  resendStub.respondNext(resendError(422, "validation_error", "Invalid `to` field."));

  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(await getSending(worker, draft.id)).toStrictEqual({
    status: "FAILED",
    failure: {
      reason: "REJECTED_BY_RESEND",
      resendErrorName: "validation_error",
      resendErrorMessage: "Invalid `to` field.",
    },
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a 409 invalid_idempotent_request from Resend is final: FAILED / REJECTED_BY_RESEND", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  resendStub.respondNext(
    resendError(409, "invalid_idempotent_request", "The request body was modified."),
  );

  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(await getSending(worker, draft.id)).toStrictEqual({
    status: "FAILED",
    failure: {
      reason: "REJECTED_BY_RESEND",
      resendErrorName: "invalid_idempotent_request",
      resendErrorMessage: "The request body was modified.",
    },
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a 503 from Resend is retryable: the message is retried after the backoff and the Draft stays QUEUED", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  resendStub.respondNext(resendError(503, "service_unavailable", "Unavailable."));

  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);

  expect(handlings).toStrictEqual([
    { id: "message-0", outcome: "RETRY", delaySeconds: expect.any(Number) },
  ]);
  expectWithin(expect, handlings[0]?.delaySeconds, FIRST_RETRY_DELAY);
  expect(resendStub.requests).toHaveLength(1);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a retried message that Resend then accepts makes the Draft SENT", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  resendStub.respondNext(resendError(500, "application_error", "Internal error."));
  await deliverSendQueueBatch(worker, [{ body: message }]);

  const handlings = await deliverSendQueueBatch(worker, [{ body: message, attempts: 2 }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(await getSending(worker, draft.id)).toStrictEqual({
    status: "SENT",
    emailId: resendStub.emails[0]?.id,
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("the backoff doubles with every attempt", async ({ expect, onTestFinished }) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { message } = await createApprovedDraft(worker);
  resendStub.respondNext(resendError(500, "application_error", "Internal error."));

  const [handling] = await deliverSendQueueBatch(worker, [{ body: message, attempts: 5 }]);

  expect(handling?.outcome).toBe("RETRY");
  expectWithin(expect, handling?.delaySeconds, { min: 16, max: 17 });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a 429 with a Retry-After longer than the backoff is retried after the Retry-After", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  resendStub.respondNext({
    ...resendError(429, "rate_limit_exceeded", "Too many requests."),
    headers: { "Retry-After": "30" },
  });

  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "RETRY", delaySeconds: 30 }]);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("the retry delay is clamped so that the next delivery is no later than the deadline", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { message } = await createApprovedDraft(worker);
  resendStub.respondNext({
    ...resendError(429, "daily_quota_exceeded", "Daily quota exceeded."),
    headers: { "Retry-After": "3600" },
  });

  const [handling] = await deliverSendQueueBatch(worker, [
    { body: { ...message, deadline: Temporal.Now.instant().epochMilliseconds + 5000 } },
  ]);

  expect(handling?.outcome).toBe("RETRY");
  expectWithin(expect, handling?.delaySeconds, { min: 2, max: 5 });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a network error is retryable", async ({ expect, onTestFinished }) => {
  // Nothing listens on the discard port, so no other test's stub can take the call. A closed stub's
  // port would not do: a stub of a concurrent test may get the same port from the OS.
  const unusedResendStub = await useResendStub({ onTestFinished });
  const worker = await useWorker(
    { onTestFinished },
    resendStubWorkerOptions(UNREACHABLE_RESEND_BASE_URL),
  );
  const { draft, message } = await createApprovedDraft(worker);

  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);

  expect(handlings).toStrictEqual([
    { id: "message-0", outcome: "RETRY", delaySeconds: expect.any(Number) },
  ]);
  expectWithin(expect, handlings[0]?.delaySeconds, FIRST_RETRY_DELAY);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });
  expect(unusedResendStub.requests).toStrictEqual([]);
  await expectExactlyOneEmailPerSentDraft(worker, unusedResendStub);
});

test("a Resend call that hangs past the 10 s timeout is retryable", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  resendStub.hangNext();

  const start = performance.now();
  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);
  const elapsedMilliseconds = performance.now() - start;

  expect(handlings).toStrictEqual([
    { id: "message-0", outcome: "RETRY", delaySeconds: expect.any(Number) },
  ]);
  expectWithin(expect, handlings[0]?.delaySeconds, FIRST_RETRY_DELAY);
  expect(elapsedMilliseconds).toBeGreaterThanOrEqual(10_000);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("the same message delivered twice at once sends one email: the overlapping attempt gets 409 concurrent_idempotent_requests and is retried", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  const held = resendStub.holdNext();
  const firstDelivery = deliverSendQueueBatch(worker, [{ id: "message-a", body: message }]);
  await held.received;

  const overlappingDelivery = await deliverSendQueueBatch(worker, [
    { id: "message-a", body: message },
  ]);

  expect(overlappingDelivery).toStrictEqual([
    { id: "message-a", outcome: "RETRY", delaySeconds: expect.any(Number) },
  ]);
  expectWithin(expect, overlappingDelivery[0]?.delaySeconds, FIRST_RETRY_DELAY);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });

  held.release();
  expect(await firstDelivery).toStrictEqual([{ id: "message-a", outcome: "ACK" }]);
  const sent = await getSending(worker, draft.id);
  expect(sent).toStrictEqual({ status: "SENT", emailId: resendStub.emails[0]?.id });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);

  // The retried attempt finds the Send ended and never reaches Resend.
  const retriedDelivery = await deliverSendQueueBatch(worker, [
    { id: "message-a", body: message, attempts: 2 },
  ]);

  expect(retriedDelivery).toStrictEqual([{ id: "message-a", outcome: "ACK" }]);
  expect(await getSending(worker, draft.id)).toStrictEqual(sent);
  expect(resendStub.requests).toHaveLength(2);
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("past the 23 h deadline the Send becomes FAILED / OUTCOME_UNKNOWN without calling Resend", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  const pastDeadlineMessage = await backdateApproval(
    worker,
    message,
    23 * HOUR_MILLISECONDS + 1000,
  );

  const handlings = await deliverSendQueueBatch(worker, [{ body: pastDeadlineMessage }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(resendStub.requests).toStrictEqual([]);
  expect(await getSending(worker, draft.id)).toStrictEqual({
    status: "FAILED",
    failure: { reason: "OUTCOME_UNKNOWN" },
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("just before the deadline Resend is still called", async ({ expect, onTestFinished }) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft, message } = await createApprovedDraft(worker);
  const nearDeadlineMessage = await backdateApproval(
    worker,
    message,
    23 * HOUR_MILLISECONDS - 60_000,
  );

  const handlings = await deliverSendQueueBatch(worker, [{ body: nearDeadlineMessage }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(await getSending(worker, draft.id)).toStrictEqual({
    status: "SENT",
    emailId: resendStub.emails[0]?.id,
  });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a batch starts its Resend calls together and its invocation lasts at least 1.0 s", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const approvedDrafts = [];
  for (let index = 0; index < 8; index++) {
    approvedDrafts.push(await createApprovedDraft(worker));
  }
  // While Resend holds the first call open, the other seven must still arrive.
  const held = resendStub.holdNext();

  const start = performance.now();
  const delivery = deliverSendQueueBatch(
    worker,
    approvedDrafts.map(({ message }) => ({ body: message })),
  );
  await held.received;
  await expect.poll(() => resendStub.requests.length).toBe(8);
  held.release();
  const handlings = await delivery;
  const elapsedMilliseconds = performance.now() - start;

  expect(handlings.map(({ outcome }) => outcome)).toStrictEqual(Array(8).fill("ACK"));
  expect(elapsedMilliseconds).toBeGreaterThanOrEqual(1000);
  for (const { draft } of approvedDrafts) {
    expect(await getSending(worker, draft.id)).toMatchObject({ status: "SENT" });
  }
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("a message that is not a Send intent is acked without calling Resend", async ({
  expect,
  onTestFinished,
}) => {
  const { resendStub, worker } = await useSendPipeline({ onTestFinished });
  const { draft } = await createApprovedDraft(worker);

  const handlings = await deliverSendQueueBatch(worker, [{ body: { draftId: draft.id } }]);

  expect(handlings).toStrictEqual([{ id: "message-0", outcome: "ACK" }]);
  expect(resendStub.requests).toStrictEqual([]);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

test("without RESEND_API_KEY the message is retried without calling Resend", async ({
  expect,
  onTestFinished,
}) => {
  const resendStub = await useResendStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished }, { vars: { RESEND_BASE_URL: resendStub.url } });
  const { draft, message } = await createApprovedDraft(worker);

  const handlings = await deliverSendQueueBatch(worker, [{ body: message }]);

  expect(handlings).toStrictEqual([
    { id: "message-0", outcome: "RETRY", delaySeconds: expect.any(Number) },
  ]);
  expect(resendStub.requests).toStrictEqual([]);
  expect(await getSending(worker, draft.id)).toStrictEqual({ status: "QUEUED" });
  await expectExactlyOneEmailPerSentDraft(worker, resendStub);
});

/**
 * Moves the Draft's Approval `byMilliseconds` into the past, on its row and in its Send Queue
 * message; returns the backdated message.
 */
async function backdateApproval(
  worker: TestWorker,
  message: SendQueueMessage,
  byMilliseconds: number,
): Promise<SendQueueMessage> {
  const env = await worker.getEnv();
  await env.DB.prepare(
    "UPDATE drafts SET approved_at = approved_at - ?1, deadline = deadline - ?1 WHERE id = ?2",
  )
    .bind(byMilliseconds, message.draftId)
    .run();
  return { ...message, deadline: message.deadline - byMilliseconds };
}

function expectWithin(
  expect: TestContext["expect"],
  value: number | undefined,
  { min, max }: { min: number; max: number },
): void {
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
}
