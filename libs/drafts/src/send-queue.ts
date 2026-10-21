/*
 * The Send Queue's messages (spec section 9). An Approval hands its Send intent to the Queue with one
 * message; the Queue consumer and the Send reconciler read the same shape.
 */

import { z } from "zod";

import { isDraftId, type DraftId } from "#src/ids.ts";
import type { drafts } from "#src/schema.ts";

/** The email an Approval freezes on the Draft row; the Send sends exactly this, with the body. */
export type OutgoingEmail = z.infer<typeof outgoingEmailSchema>;

export type SendQueueMessage = z.infer<typeof sendQueueMessageSchema>;

/**
 * The producer side of the Send Queue: the Approval hands its Send intent to it with `send()`, the
 * Send reconciler re-enqueues lost hand-offs with `sendBatch()`. The `SEND_QUEUE` binding satisfies
 * it; tests pass recording or failing doubles.
 */
export type SendQueue = {
  send(message: SendQueueMessage): Promise<unknown>;
  sendBatch(messages: Iterable<MessageSendRequest<SendQueueMessage>>): Promise<unknown>;
};

/** The Send Queue, as named in wrangler.jsonc. */
export const SEND_QUEUE_NAME = "resend-challenge-send";

/** The Send Queue's dead-letter queue, as named in wrangler.jsonc. */
export const SEND_DLQ_NAME = "resend-challenge-send-dlq";

const outgoingEmailSchema = z.strictObject({
  /** Resolved from `RESEND_FROM` when the Approval is recorded; not part of the review. */
  from: z.string().min(1),
  to: z.array(z.string()).min(1),
  subject: z.string(),
  /** The R2 key of the approved Revision's body. */
  bodyKey: z.string().min(1),
  /** Carries the `draft_id` tag from the start: adding it later would change the frozen body. */
  tags: z.array(z.strictObject({ name: z.string(), value: z.string() })),
});

export const sendQueueMessageSchema = z.strictObject({
  draftId: z.custom<DraftId>(
    (value) => typeof value === "string" && isDraftId(value),
    "Must be a Draft id (drf_…).",
  ),
  /** `draft-send/<draftId>`, sent to Resend as the `Idempotency-Key`. */
  idempotencyKey: z.string().min(1),
  outgoingEmail: outgoingEmailSchema,
  /** No Resend call may be made after it: `approved_at + 23 h`, in milliseconds since the epoch. */
  deadline: z.int().positive(),
});

/**
 * Builds the Send Queue message of an approved Draft from its frozen outbox columns. Throws when
 * the outbox is incomplete or malformed, which the `CHECK` constraints of `drafts` rule out.
 */
export function toSendQueueMessage(draftRow: typeof drafts.$inferSelect): SendQueueMessage {
  return sendQueueMessageSchema.parse({
    draftId: draftRow.id,
    idempotencyKey: draftRow.idempotencyKey,
    outgoingEmail: draftRow.outgoingEmail,
    deadline: draftRow.deadline,
  });
}
