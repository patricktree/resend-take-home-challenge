import type { Page } from "@playwright/test";

import { LOCAL_AGENT_TOKEN } from "@resend-challenge/api.routes";

import { expect, test } from "./fixtures.ts";
import { createDraftData, createPendingDraft, openDraftPage } from "./review-ui.ts";

test("a verdict on a Revision the Agent replaced is refused inline and not recorded", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, reviewerClient, resendStub } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Price increase"));
  await openDraftPage(page, draft);
  // The Agent revises and submits again after the Reviewer opened the Draft.
  const revised = await agentClient.drafts.revise(draft.id, {
    ...createDraftData("Price increase from March"),
    baseRevisionId: draft.latestRevision.id,
  });
  await agentClient.revisions.submit(draft.id, revised.latestRevision.id);
  const verdictRequests = recordVerdictRequests(page);

  await page.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "The Agent changed this Draft after you opened it; your verdict was not recorded.",
  );
  // The page still shows the Revision the Reviewer read.
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  const storedDraft = await reviewerClient.drafts.get(draft.id);
  expect(storedDraft.latestRevision).toMatchObject({
    id: revised.latestRevision.id,
    reviewStatus: "PENDING",
  });
  expect(storedDraft.sending).toStrictEqual({ status: "NOT_SENT" });

  await page.getByRole("button", { name: "Reload Draft" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Price increase from March" }),
  ).toBeVisible();
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
  // Nothing retried the verdict or applied it to the new Revision.
  expect(verdictRequests).toHaveLength(1);
  expect((await reviewerClient.drafts.get(draft.id)).reviewStatus).toBe("PENDING");
  expect(resendStub.requests).toStrictEqual([]);
});

test("a shown verdict error survives the Reviewer coming back to the tab: the Draft is not read again until Reload Draft", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient } = reviewEnvironment;
  // A controlled clock, so the Reviewer can be away for a minute: the Review UI reads the Draft
  // again on coming back only once its data is stale.
  await page.clock.install();
  const draft = await createPendingDraft(agentClient, createDraftData("Price increase"));
  await openDraftPage(page, draft);
  const revised = await agentClient.drafts.revise(draft.id, {
    ...createDraftData("Price increase from March"),
    baseRevisionId: draft.latestRevision.id,
  });
  await agentClient.revisions.submit(draft.id, revised.latestRevision.id);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The Agent changed this Draft after you opened it; your verdict was not recorded.",
  );
  const draftReads = recordDraftReads(page, draft.id);

  // The Reviewer is away for a minute, then comes back to the tab, which fires `visibilitychange`.
  await page.clock.fastForward("01:00");
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await page.getByRole("button", { name: "Reload Draft" }).click();

  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
  // Only Reload Draft read the Draft; coming back to the tab did not.
  expect(draftReads).toHaveLength(1);
});

test("a Rejection of a Revision approved meanwhile is refused inline and not recorded", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, reviewerClient, resendStub } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Holiday greetings"));
  await openDraftPage(page, draft);
  // The Revision is approved elsewhere (another tab, say) after this page loaded it.
  await reviewerClient.revisions.approve(draft.id, draft.latestRevision.id);
  const verdictRequests = recordVerdictRequests(page);
  const reasonInput = page.getByRole("textbox", { name: "Reason for rejection" });

  await reasonInput.fill("Wrong holiday.");
  await page.getByRole("button", { name: "Reject" }).click();

  await expect(page.getByRole("alert")).toHaveText("This Revision was already approved.");
  await expect(reasonInput).toHaveValue("Wrong holiday.");
  const storedDraft = await reviewerClient.drafts.get(draft.id);
  expect(storedDraft.latestRevision.reviewStatus).toBe("APPROVED");
  expect(storedDraft.latestRevision).not.toHaveProperty("rejectionReason");

  await page.getByRole("button", { name: "Reload Draft" }).click();

  await expect(page.getByText("Status: Approved")).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.getByRole("button")).toHaveText(["Sign out"]);
  // The earlier Approval sends exactly one email; the refused Rejection changed nothing.
  await expect(page.getByText(/^Sent \(Resend email ID .+\)$/)).toBeVisible();
  expect(resendStub.emails).toHaveLength(1);
  expect(verdictRequests).toHaveLength(1);
});

test("the same verdict again is refused inline too", async ({ page, reviewEnvironment }) => {
  const { agentClient, reviewerClient } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Holiday greetings"));
  await openDraftPage(page, draft);
  await reviewerClient.revisions.reject(draft.id, draft.latestRevision.id, {
    reason: "Wrong holiday.",
  });
  const verdictRequests = recordVerdictRequests(page);

  await page.getByRole("button", { name: "Reject" }).click();

  await expect(page.getByRole("alert")).toHaveText("This Revision was already rejected.");

  await page.getByRole("button", { name: "Reload Draft" }).click();

  await expect(page.getByText("Rejected: Wrong holiday.")).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
  expect(verdictRequests).toHaveLength(1);
});

test("a verdict with a stored Agent token asks for the Reviewer token", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, reviewerClient } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Quarterly report"));
  // The token screen refuses Agent tokens, so the test stores one directly, under the key of
  // libs/review-ui/src/reviewer-session.ts.
  await page.addInitScript((agentToken) => {
    localStorage.setItem("resend-challenge.reviewer-token", agentToken);
  }, LOCAL_AGENT_TOKEN);
  await page.goto(`/app/drafts/${draft.id}`);
  // The Agent token reads Drafts.
  await expect(page.getByRole("heading", { level: 1, name: "Quarterly report" })).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "The stored token is not the Reviewer token. Sign out and enter the Reviewer token.",
  );
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect((await reviewerClient.drafts.get(draft.id)).reviewStatus).toBe("PENDING");
});

/** Collects the page's reads of the Draft, to show which of them happened. */
function recordDraftReads(page: Page, draftId: string): string[] {
  const draftReads: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === `/api/v1/drafts/${draftId}`
    ) {
      draftReads.push(request.url());
    }
  });
  return draftReads;
}

/** Collects the page's verdict requests, to show that none is sent again. */
function recordVerdictRequests(page: Page): string[] {
  const verdictRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/(?:approval|rejection)$/.test(request.url())) {
      verdictRequests.push(request.url());
    }
  });
  return verdictRequests;
}
