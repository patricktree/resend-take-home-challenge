import { expect, test } from "#test-e2e/fixtures.ts";
import {
  createDraftData,
  createPendingDraft,
  openDraftPage,
  openReviewUi,
} from "#test-e2e/review-ui.ts";

test("the Reviewer approves a Pending Draft and sees its email sent", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, resendStub } = reviewEnvironment;
  const draftData = createDraftData("Welcome to the team");
  const draft = await createPendingDraft(agentClient, draftData);
  // Resend's answer waits for the test, so "Sending…" shows before the Send completes.
  const heldResendRequest = resendStub.holdNext();
  await openReviewUi(page);
  await page.getByRole("link", { name: "Welcome to the team" }).click();

  await page.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByText("Status: Approved")).toBeVisible();
  await expect(page.getByText("Sending…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeHidden();
  // Real Miniflare Queue delivery hands the Send to the consumer, which calls the stub.
  await heldResendRequest.received;
  heldResendRequest.release();
  // The Draft page polls while the Send is QUEUED.
  await expect(page.getByText(/^Sent \(Resend email ID .+\)$/)).toBeVisible();
  expect(resendStub.emails).toStrictEqual([
    {
      id: expect.any(String),
      idempotencyKey: `draft-send/${draft.id}`,
      email: {
        from: "drafts@resend-challenge.patricktree.me",
        to: draftData.to,
        subject: draftData.subject,
        text: draftData.body.plainText,
        tags: [{ name: "draft_id", value: draft.id }],
      },
    },
  ]);
  const sentLabel = `Sent (Resend email ID ${resendStub.emails[0]?.id})`;
  await expect(page.getByText(sentLabel)).toBeVisible();

  // The verdict invalidated both lists.
  await page.getByRole("link", { name: "Pending" }).click();
  await expect(page.getByText("No Pending Drafts.")).toBeVisible();
  await page.getByRole("link", { name: "Decided" }).click();
  await expect(
    page.getByRole("table", { name: "Decided Drafts" }).getByRole("row").nth(1).getByRole("cell"),
  ).toHaveText(["Welcome to the team", "ada@example.com", "Rev. 1", "Approved", sentLabel, /\d/]);
});

test("both verdict buttons are disabled while a verdict request is in flight", async ({
  page,
  reviewEnvironment,
}) => {
  const draft = await createPendingDraft(
    reviewEnvironment.agentClient,
    createDraftData("Quarterly report"),
  );
  await openDraftPage(page, draft);
  const approvalRequested = Promise.withResolvers<void>();
  const approvalReleased = Promise.withResolvers<void>();
  await page.route("**/approval", async (route) => {
    approvalRequested.resolve();
    await approvalReleased.promise;
    await route.continue();
  });
  const approveButton = page.getByRole("button", { name: "Approve" });
  const rejectButton = page.getByRole("button", { name: "Reject" });

  await approveButton.click();

  await approvalRequested.promise;
  await expect(approveButton).toBeDisabled();
  await expect(rejectButton).toBeDisabled();
  approvalReleased.resolve();
  await expect(page.getByText("Status: Approved")).toBeVisible();
});

test("the Reviewer rejects a Pending Draft with a reason", async ({ page, reviewEnvironment }) => {
  const { agentClient, reviewerClient, resendStub } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Office move"));
  await openDraftPage(page, draft);
  const reasonInput = page.getByLabel("Reason for rejection");
  await expect(reasonInput).toHaveAttribute("maxlength", "2000");

  await reasonInput.fill("  Mention the new office address.  ");
  await page.getByRole("button", { name: "Reject" }).click();

  // The reason is trimmed.
  await expect(page.getByText("Rejected: Mention the new office address.")).toBeVisible();
  await expect(page.getByText(/^Decided: \d/)).toBeVisible();
  await expect(page.getByRole("button")).toHaveText(["Sign out"]);
  const storedDraft = await reviewerClient.getDraft(draft.id);
  expect(storedDraft.latestRevision).toMatchObject({
    reviewStatus: "REJECTED",
    rejectionReason: "Mention the new office address.",
  });
  expect(storedDraft.sending).toStrictEqual({ status: "NOT_SENT" });
  expect(resendStub.requests).toStrictEqual([]);
});

test("the Reviewer rejects a Pending Draft without a reason", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, reviewerClient } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Office move"));
  await openDraftPage(page, draft);

  // Only spaces count as no reason.
  await page.getByLabel("Reason for rejection").fill("   ");
  await page.getByRole("button", { name: "Reject" }).click();

  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Decided: \d/)).toBeVisible();
  const storedDraft = await reviewerClient.getDraft(draft.id);
  expect(storedDraft.latestRevision.reviewStatus).toBe("REJECTED");
  expect(storedDraft.latestRevision).not.toHaveProperty("rejectionReason");
});
