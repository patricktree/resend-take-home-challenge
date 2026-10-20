import type { Page } from "@playwright/test";

import type { DraftApprovalClient } from "@draft-approval/api.client";
import {
  LOCAL_REVIEWER_TOKEN,
  type DraftDataRequest,
  type DraftSummaryResponse,
} from "@draft-approval/api.routes";

/** Enters a token on the token screen, which the page must show. */
export async function enterToken(page: Page, token: string = LOCAL_REVIEWER_TOKEN): Promise<void> {
  await page.getByLabel("Reviewer token").fill(token);
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Opens the Pending list and enters the Reviewer token. */
export async function openReviewUi(page: Page): Promise<void> {
  await page.goto("/app/");
  await enterToken(page);
}

export function createDraftData(subject: string, overrides: Partial<DraftDataRequest> = {}) {
  return {
    to: ["ada@example.com"],
    subject,
    body: { plainText: `Hi Ada,\n\nthis is "${subject}".\n` },
    ...overrides,
  } satisfies DraftDataRequest;
}

/** The Agent creates a Draft and submits its first Revision. */
export async function createPendingDraft(
  agentClient: DraftApprovalClient,
  draftData: DraftDataRequest,
): Promise<DraftSummaryResponse> {
  const draft = await agentClient.createDraft(draftData);
  return agentClient.submitRevision(draft.id, draft.latestRevision.id);
}
