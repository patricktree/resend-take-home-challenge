/*
 * The Resend adapter's entry (spec section 9, "Queue consumer" and "Classification and backoff"):
 * one `POST /emails` under the idempotency key, classified into the outcome of the Send attempt.
 * The Send Queue consumer is its only caller.
 */

import { classifyResendCall, type ResendOutcome } from "./classify-resend-call.ts";
import { postEmail, type ResendEmail } from "./post-email.ts";

/**
 * Sends the email once under the idempotency key and reports the outcome. Throws without calling
 * Resend when `RESEND_API_KEY` is not configured: that is configuration, not an answer of Resend.
 */
export async function sendEmail(
  { baseUrl, apiKey }: { baseUrl: string; apiKey: string | undefined },
  idempotencyKey: string,
  email: ResendEmail,
): Promise<ResendOutcome> {
  if (apiKey === undefined || apiKey === "") {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const outcome = classifyResendCall(await postEmail({ baseUrl, apiKey }, idempotencyKey, email));

  if (outcome.kind === "REJECTED" && outcome.resendErrorName === "invalid_idempotent_request") {
    // The same key with a different body: every attempt must send the same frozen body, so this is
    // a bug of our own.
    console.error(
      `Resend refused the request with idempotency key ${idempotencyKey} with 409 invalid_idempotent_request: ${outcome.resendErrorMessage ?? "(no message)"}`,
    );
  }
  return outcome;
}
