/*
 * The five screenshot baselines (spec section 13, "e2e"), compared pixel by pixel. The Drafts use
 * fixed text, and the values the Worker generates per run (timestamps, the Resend email id) are
 * pinned in the API responses the browser receives, so a baseline changes only when the UI does.
 * Update the baselines with `pnpm test:e2e:update` (or `pnpm validate:update-snapshots`).
 */

import type { Page } from "@playwright/test";

import { expect, test } from "#test-e2e/fixtures.ts";
import {
  createDraftData,
  createPendingDraft,
  openDraftPage,
  openReviewUi,
} from "#test-e2e/review-ui.ts";

/** 10:30 in the tests' time zone, Europe/Vienna (playwright.config.ts). */
const PINNED_TIMESTAMP = "2026-10-19T08:30:00.000Z";
const PINNED_EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const TIMESTAMP_FIELDS = new Set(["createdAt", "lastActionAt", "submittedAt", "decidedAt"]);

test("token screen", async ({ page }) => {
  await page.goto("/app/");
  await expect(page.getByLabel("Reviewer token")).toBeVisible();

  await expectScreenshot(page, "token-screen.png");
});

test("Pending list", async ({ page, reviewEnvironment }) => {
  const { agentClient } = reviewEnvironment;
  await createPendingDraft(
    agentClient,
    createDraftData("Welcome to the team", {
      to: ["ada@example.com", "grace@example.com", "linus@example.com"],
    }),
  );
  await createPendingDraft(agentClient, createDraftData("Your invoice for October"));
  await pinServerGeneratedValues(page);

  await openReviewUi(page);
  await expect(page.getByRole("table", { name: "Pending Drafts" }).getByRole("row")).toHaveCount(3);

  await expectScreenshot(page, "pending-list.png");
});

test("Draft page of a Pending Draft", async ({ page, reviewEnvironment }) => {
  const draft = await createPendingDraft(
    reviewEnvironment.agentClient,
    createDraftData("Welcome to the team"),
  );
  await pinServerGeneratedValues(page);

  await openDraftPage(page, draft);
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();

  await expectScreenshot(page, "draft-page-pending.png");
});

test("Draft page after an Approval", async ({ page, reviewEnvironment }) => {
  const draft = await createPendingDraft(
    reviewEnvironment.agentClient,
    createDraftData("Welcome to the team"),
  );
  await pinServerGeneratedValues(page);
  await openDraftPage(page, draft);

  await page.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByText(`Sent (Resend email ID ${PINNED_EMAIL_ID})`)).toBeVisible();
  await expectScreenshot(page, "draft-page-sent.png");
});

test("inline REVISION_SUPERSEDED error", async ({ page, reviewEnvironment }) => {
  const { agentClient } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Price increase"));
  await pinServerGeneratedValues(page);
  await openDraftPage(page, draft);
  await agentClient.reviseDraft(draft.id, {
    ...createDraftData("Price increase from March"),
    baseRevisionId: draft.latestRevision.id,
  });

  await page.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByRole("button", { name: "Reload Draft" })).toBeVisible();
  await expectScreenshot(page, "revision-superseded-error.png");
});

/** Replaces the per-run values in every API response with fixed ones. */
async function pinServerGeneratedValues(page: Page): Promise<void> {
  await page.route("**/api/v1/drafts**", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    await route.fulfill({ response, json: pinValues(body) });
  });
}

function pinValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => pinValues(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([field, fieldValue]) => {
      if (TIMESTAMP_FIELDS.has(field)) {
        return [field, PINNED_TIMESTAMP];
      }
      if (field === "emailId") {
        return [field, PINNED_EMAIL_ID];
      }
      return [field, pinValues(fieldValue)];
    }),
  );
}

/** Takes the screenshot once the fonts are loaded and no row shows its hover state. */
async function expectScreenshot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(name);
}
