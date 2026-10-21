import { expect, type Page } from "@playwright/test";

import type { ApiClient } from "@resend-challenge/api.client";
import {
  LOCAL_REVIEWER_TOKEN,
  type DraftDataRequest,
  type DraftSummaryResponse,
} from "@resend-challenge/api.routes";

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

/** Opens a Draft's page, enters the Reviewer token and waits until the Draft shows. */
export async function openDraftPage(page: Page, draft: DraftSummaryResponse): Promise<void> {
  await page.goto(`/app/drafts/${draft.id}`);
  await enterToken(page);
  await expect(
    page.getByRole("heading", { level: 1, name: draft.latestRevision.subject }),
  ).toBeVisible();
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
  agentClient: ApiClient,
  draftData: DraftDataRequest,
): Promise<DraftSummaryResponse> {
  const draft = await agentClient.drafts.create(draftData);
  return agentClient.revisions.submit(draft.id, draft.latestRevision.id);
}
