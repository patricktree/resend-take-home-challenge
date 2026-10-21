import { expect, test } from "./fixtures.ts";
import { createDraftData, createPendingDraft, enterToken } from "./review-ui.ts";

test("the Draft page shows the latest Revision and the earlier Rejection", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, reviewerClient } = reviewEnvironment;
  const rejected = await createPendingDraft(agentClient, createDraftData("Price increase"));
  await reviewerClient.revisions.reject(rejected.id, rejected.latestRevision.id, {
    reason: "Explain the reason.",
  });
  const revised = await agentClient.drafts.revise(rejected.id, {
    ...createDraftData("Price increase from March"),
    to: ["ada@example.com", "grace@example.com"],
    body: { plainText: "Dear customer,\n\n  <b>our prices</b> go up in March.\n" },
    baseRevisionId: rejected.latestRevision.id,
  });
  await agentClient.revisions.submit(revised.id, revised.latestRevision.id);

  await page.goto(`/app/drafts/${rejected.id}`);
  await enterToken(page);

  const draftPage = page.getByRole("article");
  await expect(
    draftPage.getByRole("heading", { level: 1, name: "Price increase from March" }),
  ).toBeVisible();
  await expect(draftPage.getByText("To: ada@example.com, grace@example.com")).toBeVisible();
  await expect(draftPage.getByText("Revision 2", { exact: true })).toBeVisible();
  await expect(draftPage.getByText("Status: Pending")).toBeVisible();
  await expect(draftPage.getByText("Revision 1 was rejected: Explain the reason.")).toBeVisible();
  // The body is text, never HTML, and keeps its line breaks and spaces.
  const body = draftPage.getByText("<b>our prices</b> go up in March.");
  await expect(body).toBeVisible();
  await expect(body).toHaveCSS("white-space", "pre-wrap");
  await expect(draftPage.locator("b")).toHaveCount(0);
});

test("an Unsubmitted Draft offers no verdict", async ({ page, reviewEnvironment }) => {
  const draft = await reviewEnvironment.agentClient.drafts.create(
    createDraftData("Draft in progress"),
  );

  await page.goto(`/app/drafts/${draft.id}`);
  await enterToken(page);

  await expect(page.getByText("Not submitted for review yet.")).toBeVisible();
  await expect(page.getByText("Status: Unsubmitted")).toBeVisible();
  await expect(page.getByRole("button")).toHaveText(["Sign out"]);
});

test("a Rejected Draft shows its verdict", async ({ page, reviewEnvironment }) => {
  const { agentClient, reviewerClient } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Holiday greetings"));
  await reviewerClient.revisions.reject(draft.id, draft.latestRevision.id, {
    reason: "Wrong holiday.",
  });

  await page.goto(`/app/drafts/${draft.id}`);
  await enterToken(page);

  await expect(page.getByText("Rejected: Wrong holiday.")).toBeVisible();
  await expect(page.getByText(/^Decided: \d/)).toBeVisible();
  await expect(page.getByRole("button")).toHaveText(["Sign out"]);
});

test("an unknown Draft id says so", async ({ page }) => {
  await page.goto("/app/drafts/drf_00000000-0000-7000-8000-000000000000");
  await enterToken(page);

  await expect(page.getByText("Draft not found.")).toBeVisible();
});
