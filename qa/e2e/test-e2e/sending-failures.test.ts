import { resendError } from "@resend-challenge/resend-stub";

import { expect, test } from "./fixtures.ts";
import { createDraftData, createPendingDraft, openDraftPage } from "./review-ui.ts";

/** More attempts than the Queue's backoff (1 s, 2 s, 4 s, …) makes within one test. */
const RETRYABLE_ANSWER_COUNT = 20;

test("an email Resend rejects shows as not sent, with Resend's error", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, resendStub } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Welcome to the team"));
  resendStub.respondNext(
    resendError(422, "validation_error", "The `to` field contains an invalid address."),
  );
  await openDraftPage(page, draft);

  await page.getByRole("button", { name: "Approve" }).click();

  // The Draft page polls while QUEUED until the consumer records Resend's final answer.
  await expect(
    page.getByText(
      "Failed: Resend rejected the email, so it was not sent (validation_error: The `to` field contains an invalid address.)",
    ),
  ).toBeVisible();
  expect(resendStub.requests).toHaveLength(1);
  expect(resendStub.emails).toStrictEqual([]);
});

test("a Send with an unknown outcome says the email may have been sent", async ({
  page,
  reviewEnvironment,
}) => {
  const { agentClient, reviewerClient, resendStub, executeSql } = reviewEnvironment;
  const draft = await createPendingDraft(agentClient, createDraftData("Welcome to the team"));
  // Every attempt fails retryably, so no Send outcome is recorded while the test runs.
  for (let answer = 1; answer <= RETRYABLE_ANSWER_COUNT; answer++) {
    resendStub.respondNext({ status: 503 });
  }
  await reviewerClient.approveRevision(draft.id, draft.latestRevision.id);
  // Every real path to `OUTCOME_UNKNOWN` takes the 23 h deadline (which travels in the Queue
  // message) or 100 failed attempts (the DLQ), so the test records the outcome as `recordFailed()`
  // in libs/drafts does.
  await executeSql(
    `UPDATE drafts SET sending_status = 'FAILED', failure_reason = 'OUTCOME_UNKNOWN' WHERE id = '${draft.id}' AND sending_status = 'QUEUED'`,
  );

  await openDraftPage(page, draft);

  await expect(
    page.getByText(
      "Failed: may have been sent; check the Resend dashboard before creating a new Draft.",
    ),
  ).toBeVisible();
  expect(resendStub.emails).toStrictEqual([]);
});
