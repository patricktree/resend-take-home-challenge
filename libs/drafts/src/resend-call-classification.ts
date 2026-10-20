/*
 * Classifies what one `POST /emails` call to Resend came back with (spec section 9, "Classification
 * and backoff"): a final result ends the Send, a retryable one hands the message back to the Queue.
 */

/** What one `POST /emails` call came back with. */
export type ResendCall =
  | {
      kind: "RESPONSE";
      status: number;
      /** The parsed JSON body; the raw text when it is not JSON, `undefined` without one. */
      body: unknown;
      /** From the `Retry-After` header, when the response has one. */
      retryAfterSeconds?: number;
    }
  | { kind: "NETWORK_ERROR"; message: string }
  | { kind: "TIMEOUT" };

export type ResendCallClassification =
  /** Final: Resend accepted the email, possibly earlier under the same idempotency key. */
  | { classification: "SENT"; emailId: string }
  /** Final: Resend refused the request, so the email definitely did not go out. */
  | { classification: "REJECTED"; resendErrorName?: string; resendErrorMessage?: string }
  /** The outcome is open; the Queue delivers the message again. */
  | { classification: "RETRYABLE"; cause: string; retryAfterSeconds?: number };

/** The 4xx statuses with which Resend says the request may succeed later. */
const RETRYABLE_CLIENT_ERROR_STATUSES = new Set([408, 429]);

export function classifyResendCall(call: ResendCall): ResendCallClassification {
  if (call.kind === "NETWORK_ERROR") {
    return { classification: "RETRYABLE", cause: `Calling Resend failed: ${call.message}` };
  }
  if (call.kind === "TIMEOUT") {
    return { classification: "RETRYABLE", cause: "Resend did not answer within 10 s." };
  }

  const { status, body } = call;
  if (status >= 200 && status < 300) {
    const emailId = readStringField(body, "id");
    if (emailId === undefined) {
      return retryable(call, `Resend answered ${status} without an email id.`);
    }
    return { classification: "SENT", emailId };
  }

  const resendErrorName = readStringField(body, "name");
  const describedStatus =
    resendErrorName === undefined ? `${status}` : `${status} ${resendErrorName}`;
  // Every other 4xx (400, 401, 403, 404, 405, 422, `409 invalid_idempotent_request`, and any
  // status or 409 name Resend may add later) means Resend refused the request.
  const isRejected =
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_CLIENT_ERROR_STATUSES.has(status) &&
    !(status === 409 && resendErrorName === "concurrent_idempotent_requests");
  if (isRejected) {
    const resendErrorMessage = readStringField(body, "message");
    return {
      classification: "REJECTED",
      ...(resendErrorName === undefined ? {} : { resendErrorName }),
      ...(resendErrorMessage === undefined ? {} : { resendErrorMessage }),
    };
  }

  // 5xx, 408, 429, `409 concurrent_idempotent_requests` and any other status leave the outcome
  // open; the deadline ends the retries at the latest.
  return retryable(call, `Resend answered ${describedStatus}.`);
}

function retryable(
  call: Extract<ResendCall, { kind: "RESPONSE" }>,
  cause: string,
): ResendCallClassification {
  return {
    classification: "RETRYABLE",
    cause,
    ...(call.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: call.retryAfterSeconds }),
  };
}

/** A non-empty string field of a JSON object body. */
function readStringField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null || !(field in body)) {
    return undefined;
  }
  const value: unknown = Reflect.get(body, field);
  return typeof value === "string" && value !== "" ? value : undefined;
}
