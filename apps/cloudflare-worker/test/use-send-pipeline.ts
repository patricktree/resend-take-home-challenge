/*
 * The fixture of the Send pipeline tests: a test Worker that sends through its own Resend stub, and
 * Drafts approved through the API, whose Send Queue messages tests then deliver themselves.
 */

import type { TestContext } from "vitest";

import {
  draftSummarySchema,
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  type DraftDataRequest,
  type DraftSummaryResponse,
} from "@draft-approval/api.routes";
import type { SendQueueMessage } from "@draft-approval/drafts";
import type { ResendStub } from "@draft-approval/resend-stub";

import { resendStubWorkerOptions, useResendStub } from "#test/use-resend-stub.ts";
import { readSentSendQueueMessages, useWorker, type TestWorker } from "#test/use-worker.ts";

/** The Draft that `createApprovedDraft()` creates. */
export const DRAFT_DATA = {
  to: ["ada@example.com", "grace@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada and Grace,\n\nthe report is attached.\n" },
};

const AGENT_HEADERS = {
  Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

/** A Resend stub and a test Worker that sends through it. */
export async function useSendPipeline(
  context: Pick<TestContext, "onTestFinished">,
): Promise<{ resendStub: ResendStub; worker: TestWorker }> {
  const resendStub = await useResendStub(context);
  const worker = await useWorker(context, resendStubWorkerOptions(resendStub.url));
  return { resendStub, worker };
}

/**
 * Creates, submits and approves a Draft, with {@link DRAFT_DATA} unless given other Draft data;
 * returns its summary and its Send Queue message.
 */
export async function createApprovedDraft(
  worker: TestWorker,
  draftData: DraftDataRequest = DRAFT_DATA,
): Promise<{ draft: DraftSummaryResponse; message: SendQueueMessage }> {
  const created = await expectSummary(
    await worker.fetch("/api/v1/drafts", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify(draftData),
    }),
  );
  const revisionPath = `/api/v1/drafts/${created.id}/revisions/${created.latestRevision.id}`;
  await expectSummary(
    await worker.fetch(`${revisionPath}/submission`, { method: "POST", headers: AGENT_HEADERS }),
  );
  const draft = await expectSummary(
    await worker.fetch(`${revisionPath}/approval`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` },
    }),
  );

  const message = (await readSentSendQueueMessages(worker)).find(
    ({ draftId }) => draftId === draft.id,
  );
  if (message === undefined) {
    throw new Error(`The Approval of Draft ${draft.id} sent no Send Queue message.`);
  }
  return { draft, message };
}

/** Gets the Draft and returns the response body as is. */
export async function getDraft(worker: TestWorker, draftId: string): Promise<unknown> {
  const response = await worker.fetch(`/api/v1/drafts/${draftId}`, { headers: AGENT_HEADERS });
  if (response.status !== 200) {
    throw new Error(`Getting the Draft answered with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

/** The `sending` of the Draft, as the API answers it. */
export async function getSending(worker: TestWorker, draftId: string): Promise<unknown> {
  const draft = await getDraft(worker, draftId);
  return typeof draft === "object" && draft !== null && "sending" in draft
    ? draft.sending
    : undefined;
}

/** The failure columns of the Draft row, which the API shows only while the Send is `FAILED`. */
export async function readFailureColumns(worker: TestWorker, draftId: string) {
  const env = await worker.getEnv();
  return env.DB.prepare(
    "SELECT failure_reason, resend_error_name, resend_error_message FROM drafts WHERE id = ?",
  )
    .bind(draftId)
    .first();
}

async function expectSummary(
  response: Awaited<ReturnType<TestWorker["fetch"]>>,
): Promise<DraftSummaryResponse> {
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`The request answered with ${response.status}: ${await response.text()}`);
  }
  return draftSummarySchema.parse(await response.json());
}
