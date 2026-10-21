/*
 * The Send Queue consumer (spec section 9, "Queue consumer"): the only code that calls Resend, with
 * the Queue as the only retry clock. Each message is one Draft's Send intent and makes at most one
 * `POST /emails`, never `POST /emails/batch`: the batch endpoint takes one idempotency key per
 * request, and Queue batches are not stable across retries.
 */

import { Temporal } from "temporal-polyfill";
import { z } from "zod";

import { drizzleForSession } from "./database.ts";
import { classifyResendCall } from "./resend-call-classification.ts";
import { postEmail, type ResendConnection } from "./resend-client.ts";
import { getRevisionBodyAt } from "./revision-bodies.ts";
import { findRootCauseMessage } from "./root-cause.ts";
import { isPastSendDeadline } from "./send-deadline.ts";
import { hasSendEnded, recordFailed, recordSent } from "./send-outcomes.ts";
import { sendQueueMessageSchema, type SendQueueMessage } from "./send-queue.ts";
import { computeRetryDelaySeconds } from "./send-retry-delay.ts";

/** The Worker bindings, vars and secrets the Send pipeline reads. */
export type SendPipelineEnvironment = {
  DB: D1Database;
  REVISION_BODIES: R2Bucket;
  /** Resend's API origin; tests point it at a stub. */
  RESEND_BASE_URL: string;
  /** A secret; a Worker without it retries every Send until the deadline ends it. */
  RESEND_API_KEY?: string;
};

/**
 * Every invocation lasts at least this long. With `max_concurrency: 1` and `max_batch_size: 8`,
 * that keeps the Worker at about 8 Resend requests per second, under Resend's 10 per second per
 * team.
 */
const MINIMUM_INVOCATION_MILLISECONDS = 1000;

/**
 * Consumes one batch of the Send Queue: starts the Resend calls of all its messages together, and
 * returns once they have settled and at least 1.0 s has passed. Settles every message itself: a
 * final result is recorded and acked, a retryable one is retried with a backoff.
 */
export async function consumeSendBatch(
  batch: MessageBatch,
  env: SendPipelineEnvironment,
): Promise<void> {
  const { database } = drizzleForSession(env.DB, "first-primary");
  const pacing = new Promise((resolve) => setTimeout(resolve, MINIMUM_INVOCATION_MILLISECONDS));

  await Promise.all([
    pacing,
    ...batch.messages.map((message) => consumeSendMessage(message, { database, env })),
  ]);
}

type SendContext = {
  database: ReturnType<typeof drizzleForSession>["database"];
  env: SendPipelineEnvironment;
};

async function consumeSendMessage(message: Message, context: SendContext): Promise<void> {
  const parsedMessage = sendQueueMessageSchema.safeParse(message.body);
  if (!parsedMessage.success) {
    // Without a frozen email there is nothing that could ever be sent; the Send reconciler's
    // backstop resolves the Draft's Send, if there is one.
    console.error(
      `Send Queue message ${message.id} is not a Send intent and is dropped. ${z.prettifyError(parsedMessage.error)}`,
    );
    message.ack();
    return;
  }
  const sendIntent = parsedMessage.data;

  try {
    await attemptSend(message, sendIntent, context);
  } catch (error) {
    console.error(
      `Sending Draft ${sendIntent.draftId} failed; the Send Queue delivers it again. ${findRootCauseMessage(error)}`,
    );
    retryLater(message, sendIntent);
  }
}

/** One Send attempt; settles the message unless it throws. */
async function attemptSend(
  message: Message,
  { draftId, idempotencyKey, outgoingEmail, deadline }: SendQueueMessage,
  { database, env }: SendContext,
): Promise<void> {
  // A duplicate of an ended Send never reaches Resend: whether Resend replays a refusal under the
  // same key is unverified, so a `REJECTED_BY_RESEND` ("definitely not sent") must not be retried.
  // An attempt already in flight when the Send ends still records a late `SENT`.
  if (await hasSendEnded(database, draftId)) {
    message.ack();
    return;
  }

  const body = await getRevisionBodyAt(env.REVISION_BODIES, outgoingEmail.bodyKey);
  // Right before the call, after every read: no Resend call is ever made after the deadline.
  if (isPastSendDeadline(deadline, Temporal.Now.instant().epochMilliseconds)) {
    await recordFailed(database, draftId, { reason: "OUTCOME_UNKNOWN" });
    message.ack();
    return;
  }

  const call = await postEmail(readResendConnection(env), idempotencyKey, {
    from: outgoingEmail.from,
    to: outgoingEmail.to,
    subject: outgoingEmail.subject,
    text: body.plainText,
    tags: outgoingEmail.tags,
  });
  const classification = classifyResendCall(call);

  if (classification.classification === "SENT") {
    await recordSent(database, draftId, classification.emailId);
    message.ack();
    return;
  }

  if (classification.classification === "REJECTED") {
    const { resendErrorName, resendErrorMessage } = classification;
    if (resendErrorName === "invalid_idempotent_request") {
      // The same key with a different body: every attempt must send the same frozen body, so
      // this is a bug of our own.
      console.error(
        `Resend refused the Send of Draft ${draftId} with 409 invalid_idempotent_request: ${resendErrorMessage ?? "(no message)"}`,
      );
    }
    await recordFailed(database, draftId, {
      reason: "REJECTED_BY_RESEND",
      ...(resendErrorName === undefined ? {} : { resendErrorName }),
      ...(resendErrorMessage === undefined ? {} : { resendErrorMessage }),
    });
    message.ack();
    return;
  }

  retryLater(message, { deadline }, classification.retryAfterSeconds);
}

/** Hands the message back to the Queue, to be delivered again no later than the deadline. */
function retryLater(
  message: Message,
  { deadline }: Pick<SendQueueMessage, "deadline">,
  retryAfterSeconds?: number,
): void {
  message.retry({
    delaySeconds: computeRetryDelaySeconds({
      attempts: message.attempts,
      jitter: Math.random(),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      deadline,
      now: Temporal.Now.instant().epochMilliseconds,
    }),
  });
}

function readResendConnection(env: SendPipelineEnvironment): ResendConnection {
  if (env.RESEND_API_KEY === undefined || env.RESEND_API_KEY === "") {
    throw new Error("RESEND_API_KEY is not configured.");
  }
  return { baseUrl: env.RESEND_BASE_URL, apiKey: env.RESEND_API_KEY };
}
