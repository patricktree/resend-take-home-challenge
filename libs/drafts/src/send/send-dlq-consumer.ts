/*
 * The DLQ consumer (spec section 9, "DLQ consumer"). The Send Queue moves a message to its
 * dead-letter queue after `max_retries` failed deliveries; the 23 h deadline ends every Send long
 * before that many retries, so only a crash-looping message gets there. The Send reconciler's
 * backstop would resolve these Sends anyway; the DLQ consumer is the fast path.
 */

import { z } from "zod";

import { findRootCauseMessage } from "../root-cause.ts";
import { drizzleForSession } from "../storage/database.ts";
import { recordFailed } from "../storage/send-outcomes.ts";
import { sendQueueMessageSchema } from "./send-queue.ts";

/**
 * Consumes one batch of the Send DLQ: records `FAILED` / `OUTCOME_UNKNOWN` for each message's Send,
 * logs it, and acks it. The write is conditional on `QUEUED`, so a Send that already ended keeps
 * its outcome, and a late `SENT` still overrides this one.
 */
export async function consumeSendDlqBatch(
  batch: MessageBatch,
  env: { DB: D1Database },
): Promise<void> {
  const { database } = drizzleForSession(env.DB, "first-primary");

  for (const message of batch.messages) {
    const parsedMessage = sendQueueMessageSchema.safeParse(message.body);
    if (!parsedMessage.success) {
      console.error(
        `Send DLQ message ${message.id} is not a Send intent and is dropped. ${z.prettifyError(parsedMessage.error)}`,
      );
      message.ack();
      continue;
    }
    const { draftId } = parsedMessage.data;

    try {
      await recordFailed(database, draftId, { reason: "OUTCOME_UNKNOWN" });
    } catch (error) {
      // The backstop resolves the Send at the latest, should the DLQ's own retries fail as well.
      console.error(
        `Recording the dead-lettered Send of Draft ${draftId} failed; the Send DLQ delivers it again. ${findRootCauseMessage(error)}`,
      );
      message.retry();
      continue;
    }

    console.error(
      `The Send of Draft ${draftId} reached the Send DLQ and is recorded as FAILED / OUTCOME_UNKNOWN.`,
    );
    message.ack();
  }
}
