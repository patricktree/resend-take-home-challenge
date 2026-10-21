/*
 * The Send Queue's messages (spec section 9). An Approval hands its Send intent to the Queue with one
 * message; the Queue consumer and the Send reconciler read the same shape.
 */

import { z } from "zod";

import type { OutgoingEmail } from "../domain/draft.ts";
import { isDraftId, type DraftId } from "../domain/ids.ts";

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

/**
 * Cloudflare Queues' limits of one `sendBatch()`
 * (https://developers.cloudflare.com/queues/platform/limits/): 100 messages and 256 KB in total,
 * with KB read as 1000 bytes, the stricter reading. Each message counts its body plus up to about
 * 100 bytes of internal metadata, reserved here. A message of the largest Draft data is about 17
 * KB, so 100 of them need several calls. The recording Send Queue double of the tests
 * (`test/recording-send-queue.ts`) refuses a `sendBatch()` over these same limits.
 */
export const QUEUE_BATCH_LIMITS = {
  MESSAGES: 100,
  BYTES: 256 * 1000,
  METADATA_BYTES_PER_MESSAGE: 100,
} as const;

/** Validates a frozen outgoing email, which the domain type `OutgoingEmail` defines. */
const outgoingEmailSchema = z.strictObject({
  from: z.string().min(1),
  to: z.array(z.string()).min(1),
  subject: z.string(),
  bodyKey: z.string().min(1),
  tags: z.array(z.strictObject({ name: z.string(), value: z.string() })),
}) satisfies z.ZodType<OutgoingEmail>;

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
