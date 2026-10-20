import type { DraftApprovalClient } from "@draft-approval/api.client";
import type { DraftDataRequest, DraftSummaryResponse } from "@draft-approval/api.routes";

export type SeedDraftsOptions = {
  /** Plays the Agent's moves: create, revise, submit. */
  agentClient: DraftApprovalClient;
  /** Renders the verdicts. */
  reviewerClient: DraftApprovalClient;
  print: (line: string) => void;
};

/**
 * Resend's test recipient: local Sends call the real Resend API with the developer's own key, and
 * this address exercises it without delivering mail.
 */
const TEST_RECIPIENT = "delivered@resend.dev";

const PENDING_DRAFTS: DraftDataRequest[] = [
  {
    to: [TEST_RECIPIENT],
    subject: "Welcome to the team",
    body: { plainText: "Hi Ada,\n\nwelcome aboard! Your first week's schedule is attached.\n" },
  },
  {
    to: [TEST_RECIPIENT],
    subject: "Your invoice for October",
    body: { plainText: "Hello Grace,\n\nplease find your invoice for October attached.\n" },
  },
];

/**
 * Creates a handful of Drafts in every review state the Review UI shows: Pending ones (one of them
 * on its second Revision), one Rejected with a reason and one Approved to Resend's test recipient.
 */
export async function seedDrafts({
  agentClient,
  reviewerClient,
  print,
}: SeedDraftsOptions): Promise<void> {
  for (const draftData of PENDING_DRAFTS) {
    const pending = await createAndSubmit(agentClient, draftData);
    printDraft(print, pending);
  }

  const created = await agentClient.createDraft({
    to: [TEST_RECIPIENT],
    subject: "Meeting notes",
    body: { plainText: "Hi all,\n\nnotes from today's meeting below.\n" },
  });
  const revised = await agentClient.reviseDraft(created.id, {
    to: [TEST_RECIPIENT],
    subject: "Meeting notes from Tuesday",
    body: { plainText: "Hi all,\n\nnotes from Tuesday's meeting below, with the action items.\n" },
    baseRevisionId: created.latestRevision.id,
  });
  printDraft(print, await agentClient.submitRevision(revised.id, revised.latestRevision.id));

  const toReject = await createAndSubmit(agentClient, {
    to: [TEST_RECIPIENT],
    subject: "Price increase",
    body: { plainText: "Dear customer,\n\nour prices go up by 40% next month.\n" },
  });
  printDraft(
    print,
    await reviewerClient.rejectRevision(toReject.id, toReject.latestRevision.id, {
      reason: "Too abrupt: explain the reason and give customers a date.",
    }),
  );

  const toApprove = await createAndSubmit(agentClient, {
    to: [TEST_RECIPIENT],
    subject: "Your order has shipped",
    body: { plainText: "Hi Linus,\n\nyour order is on its way and arrives on Friday.\n" },
  });
  printDraft(
    print,
    await reviewerClient.approveRevision(toApprove.id, toApprove.latestRevision.id),
  );
}

async function createAndSubmit(
  agentClient: DraftApprovalClient,
  draftData: DraftDataRequest,
): Promise<DraftSummaryResponse> {
  const created = await agentClient.createDraft(draftData);
  return agentClient.submitRevision(created.id, created.latestRevision.id);
}

function printDraft(print: (line: string) => void, draft: DraftSummaryResponse): void {
  print(`${draft.reviewStatus.padEnd(8)} ${draft.id}  ${draft.latestRevision.subject}`);
}
