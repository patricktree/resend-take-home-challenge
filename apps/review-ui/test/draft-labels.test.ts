import { expect, test } from "vitest";

import { sendingStatusLabel } from "#src/draft-labels.ts";

// The expected labels are the table of spec section 11, "Sending status labels".

test("a Draft without an Approval is not sent", () => {
  expect(sendingStatusLabel({ status: "NOT_SENT" })).toBe("Not sent");
});

test("a queued Send is sending", () => {
  expect(sendingStatusLabel({ status: "QUEUED" })).toBe("Sending…");
});

test("a sent email names its Resend email id", () => {
  expect(
    sendingStatusLabel({ status: "SENT", emailId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }),
  ).toBe("Sent (Resend email ID 4ef9a417-02e9-4d39-ad75-9611e0fcc33c)");
});

test("an email Resend rejected was not sent, with Resend's error name and message", () => {
  expect(
    sendingStatusLabel({
      status: "FAILED",
      failure: {
        reason: "REJECTED_BY_RESEND",
        resendErrorName: "validation_error",
        resendErrorMessage: "The `to` field must contain valid email addresses.",
      },
    }),
  ).toBe(
    "Failed: Resend rejected the email, so it was not sent (validation_error: The `to` field must contain valid email addresses.)",
  );
});

test("an email Resend rejected without an error name or message omits the parentheses", () => {
  expect(sendingStatusLabel({ status: "FAILED", failure: { reason: "REJECTED_BY_RESEND" } })).toBe(
    "Failed: Resend rejected the email, so it was not sent",
  );
});

test("a Send with an unknown outcome may have been sent", () => {
  expect(sendingStatusLabel({ status: "FAILED", failure: { reason: "OUTCOME_UNKNOWN" } })).toBe(
    "Failed: may have been sent; check the Resend dashboard before creating a new Draft.",
  );
});
