import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures.ts";
import { createDraftData, createPendingDraft, openReviewUi } from "./review-ui.ts";

/** The API's default page size, which the lists use. */
const PAGE_SIZE = 50;

test("both lists say when they are empty", async ({ page }) => {
  await openReviewUi(page);

  await expect(page.getByText("No Pending Drafts.")).toBeVisible();
  await page.getByRole("link", { name: "Decided" }).click();
  await expect(page.getByText("No Decided Drafts.")).toBeVisible();
});

test("the Pending list shows the longest-waiting Draft first and its columns", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient } = reviewEnvironment;
  await createPendingDraft(
    agentClient,
    createDraftData("Welcome to the team", {
      to: ["ada@example.com", "grace@example.com", "linus@example.com"],
    }),
  );
  await createPendingDraft(agentClient, createDraftData("Your invoice"));
  // Unsubmitted Drafts never appear in the lists.
  await agentClient.drafts.create(createDraftData("Not submitted yet"));

  await openReviewUi(page);

  const table = page.getByRole("table", { name: "Pending Drafts" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Subject",
    "To",
    "Revision",
    "Submitted",
  ]);
  const rows = table.getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1).getByRole("cell")).toHaveText([
    "Welcome to the team",
    "ada@example.com +2",
    "Rev. 1",
    /\d/,
  ]);
  await expect(rows.nth(2).getByRole("cell").first()).toHaveText("Your invoice");
});

test("the Pending list pages with Load more", async ({ page, reviewEnvironment }) => {
  for (let draftNumber = 1; draftNumber <= PAGE_SIZE + 1; draftNumber++) {
    await createPendingDraft(
      reviewEnvironment.agentClient,
      createDraftData(`Draft ${draftNumber}`),
    );
  }

  await openReviewUi(page);

  await expectPagingThroughOneMoreDraftThanAPage(page, "Pending Drafts");
});

test("the Decided list shows the newest verdict first and its columns", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, reviewerClient } = reviewEnvironment;
  const first = await createPendingDraft(agentClient, createDraftData("Price increase"));
  await reviewerClient.revisions.reject(first.id, first.latestRevision.id, {
    reason: "Too abrupt.",
  });
  const second = await createPendingDraft(agentClient, createDraftData("Holiday greetings"));
  await reviewerClient.revisions.reject(second.id, second.latestRevision.id);

  await openReviewUi(page);
  await page.getByRole("link", { name: "Decided" }).click();

  const table = page.getByRole("table", { name: "Decided Drafts" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Subject",
    "To",
    "Revision",
    "Verdict",
    "Sending",
    "Decided",
  ]);
  const rows = table.getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1).getByRole("cell")).toHaveText([
    "Holiday greetings",
    "ada@example.com",
    "Rev. 1",
    "Rejected",
    "Not sent",
    /\d/,
  ]);
  await expect(rows.nth(2).getByRole("cell").first()).toHaveText("Price increase");
});

test("the Decided list pages with Load more", async ({ page, reviewEnvironment }) => {
  const { agentClient, reviewerClient } = reviewEnvironment;
  for (let draftNumber = 1; draftNumber <= PAGE_SIZE + 1; draftNumber++) {
    const draft = await createPendingDraft(agentClient, createDraftData(`Draft ${draftNumber}`));
    await reviewerClient.revisions.reject(draft.id, draft.latestRevision.id);
  }

  await openReviewUi(page);
  await page.getByRole("link", { name: "Decided" }).click();

  await expectPagingThroughOneMoreDraftThanAPage(page, "Decided Drafts");
});

test("a row links to its Draft page", async ({ page, reviewEnvironment }) => {
  const draft = await createPendingDraft(
    reviewEnvironment.agentClient,
    createDraftData("Meeting notes"),
  );
  await openReviewUi(page);

  await page.getByRole("link", { name: "Meeting notes" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Meeting notes" })).toBeVisible();
  await expect(page).toHaveURL(`/app/drafts/${draft.id}`);
});

/** The first page holds a full page of Drafts; "Load more" adds the last one and disappears. */
async function expectPagingThroughOneMoreDraftThanAPage(
  page: Page,
  tableName: string,
): Promise<void> {
  const bodyRows = page
    .getByRole("table", { name: tableName })
    .getByRole("row")
    .filter({
      has: page.getByRole("cell"),
    });
  const loadMoreButton = page.getByRole("button", { name: "Load more" });
  await expect(bodyRows).toHaveCount(PAGE_SIZE);

  await loadMoreButton.click();

  await expect(bodyRows).toHaveCount(PAGE_SIZE + 1);
  await expect(loadMoreButton).toBeHidden();
}
