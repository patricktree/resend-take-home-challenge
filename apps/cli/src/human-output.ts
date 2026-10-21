import type {
  DraftListResponse,
  DraftResponse,
  DraftSummaryResponse,
  RevisionResponse,
} from "@resend-challenge/api.routes";

/** The Draft summary that create, revise and submit return. */
export function formatDraftSummary(draft: DraftSummaryResponse): string {
  const { latestRevision, lastVerdict } = draft;
  const lines = [
    `Draft ${draft.id}`,
    `Review status: ${draft.reviewStatus}`,
    `Sending status: ${formatSending(draft.sending)}`,
    `Latest Revision: ${latestRevision.id} (Revision ${latestRevision.revisionNumber}, ${latestRevision.reviewStatus})`,
  ];
  if (lastVerdict !== undefined) {
    const reason = lastVerdict.reason === undefined ? "" : `: ${lastVerdict.reason}`;
    lines.push(
      `Last verdict: ${lastVerdict.verdict} on Revision ${lastVerdict.revisionNumber}${reason}`,
    );
  }
  lines.push(`Review URL: ${draft.reviewUrl}`);
  return lines.join("\n");
}

/** A Draft with the recipients, subject and body of its latest Revision. */
export function formatDraft(draft: DraftResponse): string {
  return [formatDraftSummary(draft), formatEmail(draft.latestRevision)].join("\n\n");
}

/** One block per Draft, then the cursor of the next page while there is one. */
export function formatDraftList(list: DraftListResponse): string {
  if (list.items.length === 0) {
    return "No Drafts.";
  }
  const blocks = list.items.map(
    (draft) => `${formatDraftSummary(draft)}\nSubject: ${draft.latestRevision.subject}`,
  );
  if (list.nextCursor !== undefined) {
    blocks.push(`Next page: --cursor ${list.nextCursor}`);
  }
  return blocks.join("\n\n");
}

/** A Revision with its recipients, subject and body. */
export function formatRevision(revision: RevisionResponse): string {
  const lines = [
    `Revision ${revision.id} (Revision ${revision.revisionNumber})`,
    `Review status: ${revision.reviewStatus}`,
  ];
  if (revision.rejectionReason !== undefined) {
    lines.push(`Rejection reason: ${revision.rejectionReason}`);
  }
  return [lines.join("\n"), formatEmail(revision)].join("\n\n");
}

function formatSending(sending: DraftSummaryResponse["sending"]): string {
  switch (sending.status) {
    case "NOT_SENT":
    case "QUEUED": {
      return sending.status;
    }
    case "SENT": {
      return `SENT (Resend email ${sending.emailId})`;
    }
    case "FAILED": {
      const { reason, resendErrorName, resendErrorMessage } = sending.failure;
      const details = [resendErrorName, resendErrorMessage].filter(
        (detail) => detail !== undefined,
      );
      return `FAILED (${[reason, ...details].join(": ")})`;
    }
    default: {
      return assertUnreachable(sending);
    }
  }
}

/** Fails to compile when a switch misses a case, and throws if an unexpected value arrives anyway. */
function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

function formatEmail(revision: RevisionResponse): string {
  return [
    `To: ${revision.to.join(", ")}`,
    `Subject: ${revision.subject}`,
    "",
    revision.body.plainText,
  ].join("\n");
}
