import { Temporal } from "temporal-polyfill";

import type { DraftSummaryResponse } from "@resend-challenge/api.routes";

import { assertUnreachable } from "#src/assert-unreachable.ts";

type Sending = DraftSummaryResponse["sending"];

type ReviewStatus = DraftSummaryResponse["reviewStatus"];

const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  UNSUBMITTED: "Unsubmitted",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

/** The sending status as the Decided list and the Draft page show it (spec section 11). */
export function sendingStatusLabel(sending: Sending): string {
  switch (sending.status) {
    case "NOT_SENT": {
      return "Not sent";
    }
    case "QUEUED": {
      return "Sending…";
    }
    case "SENT": {
      return `Sent (Resend email ID ${sending.emailId})`;
    }
    case "FAILED": {
      return failedSendingLabel(sending.failure);
    }
    default: {
      return assertUnreachable(sending);
    }
  }
}

export function reviewStatusLabel(reviewStatus: ReviewStatus): string {
  return REVIEW_STATUS_LABELS[reviewStatus];
}

/** The first recipient, then "+N" for the others. */
export function shortRecipientsLabel(recipients: readonly string[]): string {
  const [firstRecipient, ...otherRecipients] = recipients;
  if (firstRecipient === undefined) {
    throw new Error("A Revision always has at least one recipient.");
  }
  return otherRecipients.length === 0
    ? firstRecipient
    : `${firstRecipient} +${otherRecipients.length}`;
}

/** An API timestamp as absolute local time. */
export function localTimeLabel(timestamp: string): string {
  return Temporal.Instant.from(timestamp).toLocaleString();
}

function failedSendingLabel(failure: Extract<Sending, { status: "FAILED" }>["failure"]): string {
  switch (failure.reason) {
    case "REJECTED_BY_RESEND": {
      const resendError = [failure.resendErrorName, failure.resendErrorMessage]
        .filter((part) => part !== undefined)
        .join(": ");
      const resendErrorSuffix = resendError === "" ? "" : ` (${resendError})`;
      return `Failed: Resend rejected the email, so it was not sent${resendErrorSuffix}`;
    }
    case "OUTCOME_UNKNOWN": {
      return "Failed: may have been sent; check the Resend dashboard before creating a new Draft.";
    }
    default: {
      return assertUnreachable(failure.reason);
    }
  }
}
