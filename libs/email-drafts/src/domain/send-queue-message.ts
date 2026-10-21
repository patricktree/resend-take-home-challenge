/*
 * The Send Queue's messages (spec section 9). An Approval hands its Send intent to the Queue with
 * one message; the Queue consumer and the Send reconciler read the same shape, and
 * `storage/send-outbox.ts` builds it from the frozen outbox columns.
 */

import { z } from "zod";

import type { OutgoingEmail } from "./draft.ts";
import { isDraftId, type DraftId } from "./ids.ts";

export type SendQueueMessage = z.infer<typeof sendQueueMessageSchema>;

/**
 * Validates a frozen outgoing email, which the domain type `OutgoingEmail` defines.
 * `test/send-queue-message.test.ts` checks the other direction: that the schema adds no field.
 */
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
