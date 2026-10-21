import { Temporal } from "temporal-polyfill";
import { test, vi } from "vitest";

import { approveRevision } from "../src/review/approve-revision.ts";
import { createDraft } from "../src/review/create-draft.ts";
import { submitRevision } from "../src/review/submit-revision.ts";
import { consumeSendBatch } from "../src/send/send-consumer.ts";
import { SEND_QUEUE_NAME, type SendQueueMessage } from "../src/send/send-queue.ts";
import { drizzleForSession, type DraftsStorage } from "../src/storage/database.ts";
import { createRecordingSendQueue } from "./recording-send-queue.ts";
import { useBindings, type TestBindings } from "./use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

const RESEND_FROM = "drafts@resend-challenge.patricktree.me";

test("a deadline that passes while the body is read from R2 ends the Send FAILED / OUTCOME_UNKNOWN without calling Resend", async ({
  expect,
  onTestFinished,
}) => {
  const bindings = await useBindings({ onTestFinished });
  const sendIntent = await createApprovedSendIntent(bindings);
  // Far enough ahead that the consumer's reads before the body are done long before it, also
  // under load; the R2 read then answers only once it has passed.
  const deadline = Temporal.Now.instant().epochMilliseconds + 2000;
  const slowRevisionBodies = new Proxy(bindings.REVISION_BODIES, {
    get: (target, property) => {
      if (property !== "get") {
        return Reflect.get(target, property);
      }
      return async (key: string) => {
        const untilPastDeadline = deadline + 100 - Temporal.Now.instant().epochMilliseconds;
        await new Promise((resolve) => setTimeout(resolve, untilPastDeadline));
        return target.get(key);
      };
    },
  });
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Resend must not be called."));
  onTestFinished(() => fetchSpy.mockRestore());
  const outcomes: string[] = [];

  await consumeSendBatch(createMessageBatch({ ...sendIntent, deadline }, outcomes), {
    DB: bindings.DB,
    REVISION_BODIES: slowRevisionBodies,
    RESEND_BASE_URL: "http://127.0.0.1:9",
    RESEND_API_KEY: "re_dummy",
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(outcomes).toStrictEqual(["ACK"]);
  const row = await bindings.DB.prepare(
    "SELECT sending_status, failure_reason FROM drafts WHERE id = ?1",
  )
    .bind(sendIntent.draftId)
    .first();
  expect(row).toStrictEqual({ sending_status: "FAILED", failure_reason: "OUTCOME_UNKNOWN" });
});

/** Creates, submits and approves a Draft; returns the Send intent its Approval handed off. */
async function createApprovedSendIntent(bindings: TestBindings): Promise<SendQueueMessage> {
  const storage: DraftsStorage = {
    database: drizzleForSession(bindings.DB, "first-primary").database,
    revisionBodies: bindings.REVISION_BODIES,
  };
  const sendQueue = createRecordingSendQueue();
  const created = await createDraft(storage, DRAFT_DATA);
  await submitRevision(storage, created.id, created.latestRevision.id);
  await approveRevision(
    storage,
    { sendQueue, from: RESEND_FROM },
    created.id,
    created.latestRevision.id,
  );

  const [sendIntent] = sendQueue.sentMessages;
  if (sendIntent === undefined) {
    throw new Error("The Approval handed off no Send intent.");
  }
  return sendIntent;
}

/** A Send Queue batch of one message whose ack and retry calls land in `outcomes`. */
function createMessageBatch(body: SendQueueMessage, outcomes: string[]): MessageBatch {
  const message: Message = {
    id: "message-0",
    // The consumer does not read it; fail loudly should that change, rather than make one up.
    get timestamp(): never {
      throw new Error("This test does not model message timestamps.");
    },
    body,
    attempts: 1,
    ack: () => {
      outcomes.push("ACK");
    },
    retry: () => {
      outcomes.push("RETRY");
    },
  };
  return {
    queue: SEND_QUEUE_NAME,
    metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
    messages: [message],
    ackAll: () => {
      outcomes.push("ACK");
    },
    retryAll: () => {
      outcomes.push("RETRY");
    },
  };
}
