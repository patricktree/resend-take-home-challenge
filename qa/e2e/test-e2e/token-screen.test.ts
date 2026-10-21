import { LOCAL_AGENT_TOKEN } from "@resend-challenge/api.routes";

import { expect, test } from "./fixtures.ts";
import { createDraftData, createPendingDraft, enterToken, openReviewUi } from "./review-ui.ts";

test("an Agent token is refused before any request", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      apiRequests.push(request.url());
    }
  });
  await page.goto("/app/");

  await enterToken(page, LOCAL_AGENT_TOKEN);

  await expect(page.getByRole("alert")).toHaveText(
    "This is an Agent token. Enter the Reviewer token.",
  );
  await expect(page.getByLabel("Reviewer token")).toBeVisible();
  expect(apiRequests).toStrictEqual([]);
});

test("a token the API does not accept leads back to the token screen", async ({
  page,
  reviewEnvironment,
}) => {
  const draft = await createPendingDraft(
    reviewEnvironment.agentClient,
    createDraftData("Quarterly report"),
  );
  await page.goto(`/app/drafts/${draft.id}`);

  await enterToken(page, "reviewer_not-the-configured-token");

  await expect(page.getByRole("alert")).toHaveText("The token was not accepted.");
  await expect(page.getByLabel("Reviewer token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeHidden();
  // The right token then loads the same route.
  await enterToken(page);
  await expect(page.getByRole("heading", { level: 1, name: "Quarterly report" })).toBeVisible();
});

test("a reviewUrl opened without a token lands on its Draft once the token is entered", async ({
  page,
  reviewEnvironment,
}) => {
  const draft = await createPendingDraft(
    reviewEnvironment.agentClient,
    createDraftData("Quarterly report"),
  );
  // The reviewUrl names the production origin; the test's Worker serves the same path.
  const reviewPath = new URL(draft.reviewUrl).pathname;
  expect(reviewPath).toBe(`/app/drafts/${draft.id}`);
  await page.goto(reviewPath);
  await expect(page.getByLabel("Reviewer token")).toBeVisible();

  await enterToken(page);

  await expect(page.getByRole("heading", { level: 1, name: "Quarterly report" })).toBeVisible();
  await expect(page).toHaveURL(reviewPath);
});

test("signing out forgets the token", async ({ page }) => {
  await openReviewUi(page);
  await expect(page.getByRole("heading", { name: "Pending Drafts" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page.getByLabel("Reviewer token")).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
  await page.reload();
  await expect(page.getByLabel("Reviewer token")).toBeVisible();
});

test("the token is kept for the next visit, such as another reviewUrl tab", async ({ page }) => {
  await openReviewUi(page);
  await expect(page.getByRole("heading", { name: "Pending Drafts" })).toBeVisible();

  const otherTab = await page.context().newPage();
  await otherTab.goto("/app/decided");

  await expect(otherTab.getByRole("heading", { name: "Decided Drafts" })).toBeVisible();
});
