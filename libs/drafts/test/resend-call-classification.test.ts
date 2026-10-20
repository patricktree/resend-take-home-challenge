import { expect, test } from "vitest";

import { classifyResendCall } from "#src/resend-call-classification.ts";

const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

test("a 200 with an id is final: SENT with that email id", () => {
  expect(
    classifyResendCall({ kind: "RESPONSE", status: 200, body: { id: EMAIL_ID } }),
  ).toStrictEqual({ classification: "SENT", emailId: EMAIL_ID });
});

test("another 2xx with an id is also SENT: Resend accepted the email under the key", () => {
  expect(
    classifyResendCall({ kind: "RESPONSE", status: 201, body: { id: EMAIL_ID } }),
  ).toStrictEqual({ classification: "SENT", emailId: EMAIL_ID });
});

test.for([400, 401, 403, 404, 405, 422])(
  "a %i is final: REJECTED with Resend's error name and message",
  (status) => {
    expect(
      classifyResendCall({
        kind: "RESPONSE",
        status,
        body: {
          statusCode: status,
          name: "validation_error",
          message: "The `to` field is invalid.",
        },
      }),
    ).toStrictEqual({
      classification: "REJECTED",
      resendErrorName: "validation_error",
      resendErrorMessage: "The `to` field is invalid.",
    });
  },
);

test("a 409 invalid_idempotent_request is final: REJECTED", () => {
  expect(
    classifyResendCall({
      kind: "RESPONSE",
      status: 409,
      body: {
        statusCode: 409,
        name: "invalid_idempotent_request",
        message: "This idempotency key has been used with a different request body.",
      },
    }),
  ).toStrictEqual({
    classification: "REJECTED",
    resendErrorName: "invalid_idempotent_request",
    resendErrorMessage: "This idempotency key has been used with a different request body.",
  });
});

test("a 409 concurrent_idempotent_requests is retryable", () => {
  expect(
    classifyResendCall({
      kind: "RESPONSE",
      status: 409,
      body: {
        statusCode: 409,
        name: "concurrent_idempotent_requests",
        message: "Another request with the same idempotency key is in progress.",
      },
    }),
  ).toStrictEqual({
    classification: "RETRYABLE",
    cause: "Resend answered 409 concurrent_idempotent_requests.",
  });
});

test.for([408, 429, 500, 502, 503, 504])("a %i is retryable", (status) => {
  expect(
    classifyResendCall({
      kind: "RESPONSE",
      status,
      body: { statusCode: status, name: "some_error", message: "Try again later." },
    }),
  ).toStrictEqual({ classification: "RETRYABLE", cause: `Resend answered ${status} some_error.` });
});

test("a retryable response keeps its Retry-After", () => {
  expect(
    classifyResendCall({
      kind: "RESPONSE",
      status: 429,
      body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." },
      retryAfterSeconds: 7,
    }),
  ).toStrictEqual({
    classification: "RETRYABLE",
    cause: "Resend answered 429 rate_limit_exceeded.",
    retryAfterSeconds: 7,
  });
});

test("a network error is retryable", () => {
  expect(
    classifyResendCall({ kind: "NETWORK_ERROR", message: "Network connection lost." }),
  ).toStrictEqual({
    classification: "RETRYABLE",
    cause: "Calling Resend failed: Network connection lost.",
  });
});

test("the 10 s timeout is retryable", () => {
  expect(classifyResendCall({ kind: "TIMEOUT" })).toStrictEqual({
    classification: "RETRYABLE",
    cause: "Resend did not answer within 10 s.",
  });
});

test.for([
  { status: 409, name: "resource_locked" },
  { status: 410, name: "gone" },
  { status: 418, name: "teapot" },
])("any other 4xx ($status $name) is final: REJECTED", ({ status, name }) => {
  expect(
    classifyResendCall({
      kind: "RESPONSE",
      status,
      body: { statusCode: status, name, message: "Refused." },
    }),
  ).toStrictEqual({
    classification: "REJECTED",
    resendErrorName: name,
    resendErrorMessage: "Refused.",
  });
});

test("a 4xx without Resend's error shape is REJECTED without an error name or message", () => {
  expect(classifyResendCall({ kind: "RESPONSE", status: 400, body: "Bad Request" })).toStrictEqual({
    classification: "REJECTED",
  });
});

test.for([
  { status: 302, body: undefined },
  { status: 304, body: undefined },
  { status: 600, body: undefined },
])("any other status ($status) is retryable", ({ status, body }) => {
  expect(classifyResendCall({ kind: "RESPONSE", status, body })).toStrictEqual({
    classification: "RETRYABLE",
    cause: `Resend answered ${status}.`,
  });
});

test.for([
  { status: 200, body: {} },
  { status: 200, body: { id: "" } },
  { status: 200, body: { id: 42 } },
  { status: 200, body: undefined },
  { status: 202, body: { object: "email" } },
])("a 2xx without an id ($status, $body) is retryable", ({ status, body }) => {
  expect(classifyResendCall({ kind: "RESPONSE", status, body })).toStrictEqual({
    classification: "RETRYABLE",
    cause: `Resend answered ${status} without an email id.`,
  });
});
