import { test } from "vitest";

import { useWorker } from "./use-worker.ts";

/*
 * The CHECK constraints and indexes of the D1 schema (spec section 5), exercised with raw SQL on
 * rows that no use case writes yet.
 */

const DRAFT_ID = "drf_00000000-0000-7000-8000-000000000001";
const REVISION_ID = "rev_00000000-0000-7000-8000-000000000001";
const NOW = 1_800_000_000_000;

const INSERT_DRAFT = `INSERT INTO drafts (id, created_at, last_action_at, latest_revision_id) VALUES ('${DRAFT_ID}', ${NOW}, ${NOW}, '${REVISION_ID}')`;
const INSERT_REVISION = `INSERT INTO revisions (id, draft_id, revision_number, created_at, to_addresses, subject, review_status) VALUES ('${REVISION_ID}', '${DRAFT_ID}', 1, ${NOW}, '["ada@example.com"]', 'Hello', 'UNSUBMITTED')`;
const APPROVE = `approved_revision_id = '${REVISION_ID}', approved_at = ${NOW}, idempotency_key = 'draft-send/${DRAFT_ID}', outgoing_email = '{}', deadline = ${NOW + 23 * 60 * 60 * 1000}`;

test.for([
  { name: "a QUEUED Draft with its outbox", update: `${APPROVE}, sending_status = 'QUEUED'` },
  {
    name: "a SENT Draft with its email id",
    update: `${APPROVE}, sending_status = 'SENT', email_id = 'email-1'`,
  },
  {
    name: "a FAILED Draft rejected by Resend with its error",
    update: `${APPROVE}, sending_status = 'FAILED', failure_reason = 'REJECTED_BY_RESEND', resend_error_name = 'validation_error', resend_error_message = 'Invalid to'`,
  },
  {
    name: "a FAILED Draft with an unknown outcome",
    update: `${APPROVE}, sending_status = 'FAILED', failure_reason = 'OUTCOME_UNKNOWN'`,
  },
])("the drafts table accepts $name", async ({ update }, { expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const env = await worker.getEnv();
  await env.DB.batch([env.DB.prepare(INSERT_DRAFT), env.DB.prepare(INSERT_REVISION)]);

  await env.DB.prepare(`UPDATE drafts SET ${update}`).run();

  const row = await env.DB.prepare("SELECT sending_status FROM drafts").first();
  expect(row).not.toBeNull();
});

test.for([
  {
    name: "an unknown sending status",
    constraint: "drafts_sending_status_values",
    update: "sending_status = 'DELIVERED'",
  },
  {
    name: "QUEUED without an Approval",
    constraint: "drafts_not_sent_exactly_without_approval",
    update: "sending_status = 'QUEUED'",
  },
  {
    name: "an Approval while NOT_SENT",
    constraint: "drafts_not_sent_exactly_without_approval",
    update: APPROVE,
  },
  {
    name: "an approved Revision that is not the latest",
    constraint: "drafts_approved_revision_is_latest",
    update: `${APPROVE.replace(`approved_revision_id = '${REVISION_ID}'`, "approved_revision_id = 'rev_other'")}, sending_status = 'QUEUED'`,
  },
  {
    name: "an Approval without its deadline",
    constraint: "drafts_outbox_complete_exactly_with_approval",
    update: `${APPROVE}, sending_status = 'QUEUED', deadline = NULL`,
  },
  {
    name: "an Approval without its frozen email",
    constraint: "drafts_outbox_complete_exactly_with_approval",
    update: `${APPROVE}, sending_status = 'QUEUED', outgoing_email = NULL`,
  },
  {
    name: "an outbox without an Approval",
    constraint: "drafts_outbox_complete_exactly_with_approval",
    update: `approved_at = ${NOW}, idempotency_key = 'draft-send/${DRAFT_ID}'`,
  },
  {
    name: "SENT without an email id",
    constraint: "drafts_email_id_exactly_when_sent",
    update: `${APPROVE}, sending_status = 'SENT'`,
  },
  {
    name: "an email id while QUEUED",
    constraint: "drafts_email_id_exactly_when_sent",
    update: `${APPROVE}, sending_status = 'QUEUED', email_id = 'email-1'`,
  },
  {
    name: "FAILED without a failure reason",
    constraint: "drafts_failure_reason_exactly_when_failed",
    update: `${APPROVE}, sending_status = 'FAILED'`,
  },
  {
    name: "an unknown failure reason",
    constraint: "drafts_failure_reason_values",
    update: `${APPROVE}, sending_status = 'FAILED', failure_reason = 'BOUNCED'`,
  },
  {
    name: "a failure reason while SENT",
    constraint: "drafts_failure_reason_exactly_when_failed",
    update: `${APPROVE}, sending_status = 'SENT', email_id = 'email-1', failure_reason = 'OUTCOME_UNKNOWN'`,
  },
  {
    name: "a Resend error with an unknown outcome",
    constraint: "drafts_resend_error_only_when_rejected_by_resend",
    update: `${APPROVE}, sending_status = 'FAILED', failure_reason = 'OUTCOME_UNKNOWN', resend_error_name = 'internal_server_error'`,
  },
  {
    name: "a Resend error without a failure",
    constraint: "drafts_resend_error_only_when_rejected_by_resend",
    update: "resend_error_message = 'Invalid to'",
  },
])("the drafts table refuses $name", async ({ update, constraint }, { expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const env = await worker.getEnv();
  await env.DB.batch([env.DB.prepare(INSERT_DRAFT), env.DB.prepare(INSERT_REVISION)]);

  await expect(env.DB.prepare(`UPDATE drafts SET ${update}`).run()).rejects.toThrow(
    `CHECK constraint failed: ${constraint}`,
  );
});

test.for([
  { name: "a PENDING Revision", update: `review_status = 'PENDING', submitted_at = ${NOW}` },
  {
    name: "an APPROVED Revision",
    update: `review_status = 'APPROVED', submitted_at = ${NOW}, decided_at = ${NOW}`,
  },
  {
    name: "a REJECTED Revision with a reason",
    update: `review_status = 'REJECTED', submitted_at = ${NOW}, decided_at = ${NOW}, rejection_reason = 'Wrong recipient'`,
  },
  { name: "a never submitted SUPERSEDED Revision", update: "review_status = 'SUPERSEDED'" },
  {
    name: "a submitted SUPERSEDED Revision",
    update: `review_status = 'SUPERSEDED', submitted_at = ${NOW}`,
  },
])("the revisions table accepts $name", async ({ update }, { expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const env = await worker.getEnv();
  await env.DB.batch([env.DB.prepare(INSERT_DRAFT), env.DB.prepare(INSERT_REVISION)]);

  await env.DB.prepare(`UPDATE revisions SET ${update}`).run();

  const row = await env.DB.prepare("SELECT review_status FROM revisions").first();
  expect(row).not.toBeNull();
});

test.for([
  {
    name: "an unknown review status",
    constraint: "revisions_review_status_values",
    update: "review_status = 'DISCARDED'",
  },
  {
    name: "a PENDING Revision without submitted_at",
    constraint: "revisions_submitted_at_matches_review_status",
    update: "review_status = 'PENDING'",
  },
  {
    name: "an UNSUBMITTED Revision with submitted_at",
    constraint: "revisions_submitted_at_matches_review_status",
    update: `submitted_at = ${NOW}`,
  },
  {
    name: "an APPROVED Revision without decided_at",
    constraint: "revisions_decided_at_exactly_with_verdict",
    update: `review_status = 'APPROVED', submitted_at = ${NOW}`,
  },
  {
    name: "a PENDING Revision with decided_at",
    constraint: "revisions_decided_at_exactly_with_verdict",
    update: `review_status = 'PENDING', submitted_at = ${NOW}, decided_at = ${NOW}`,
  },
  {
    name: "a rejection reason on an APPROVED Revision",
    constraint: "revisions_rejection_reason_only_when_rejected",
    update: `review_status = 'APPROVED', submitted_at = ${NOW}, decided_at = ${NOW}, rejection_reason = 'No'`,
  },
])(
  "the revisions table refuses $name",
  async ({ update, constraint }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const env = await worker.getEnv();
    await env.DB.batch([env.DB.prepare(INSERT_DRAFT), env.DB.prepare(INSERT_REVISION)]);

    await expect(env.DB.prepare(`UPDATE revisions SET ${update}`).run()).rejects.toThrow(
      `CHECK constraint failed: ${constraint}`,
    );
  },
);

test("a Draft cannot have two Revisions with the same number", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const env = await worker.getEnv();
  await env.DB.batch([env.DB.prepare(INSERT_DRAFT), env.DB.prepare(INSERT_REVISION)]);

  await expect(
    env.DB.prepare(
      INSERT_REVISION.replace(REVISION_ID, "rev_00000000-0000-7000-8000-000000000002"),
    ).run(),
  ).rejects.toThrow(/UNIQUE constraint failed/);
});

test("a Revision must belong to an existing Draft", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const env = await worker.getEnv();

  await expect(env.DB.prepare(INSERT_REVISION).run()).rejects.toThrow(
    /FOREIGN KEY constraint failed/,
  );
});

test("the schema has the indexes for list paging, list filters and the Send reconciler", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const env = await worker.getEnv();

  const { results } = await env.DB.prepare(
    "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
  ).all();

  expect(results).toStrictEqual([
    {
      tbl_name: "drafts",
      sql: "CREATE INDEX `drafts_created_at_id_index` ON `drafts` (`created_at`,`id`)",
    },
    {
      tbl_name: "drafts",
      sql: "CREATE INDEX `drafts_last_action_at_id_index` ON `drafts` (`last_action_at`,`id`)",
    },
    {
      tbl_name: "drafts",
      sql: 'CREATE INDEX `drafts_queued_deadline_index` ON `drafts` (`deadline`) WHERE "drafts"."sending_status" = \'QUEUED\'',
    },
    {
      tbl_name: "drafts",
      sql: 'CREATE INDEX `drafts_queued_not_enqueued_approved_at_index` ON `drafts` (`approved_at`) WHERE "drafts"."sending_status" = \'QUEUED\' AND "drafts"."enqueued_at" IS NULL',
    },
    {
      tbl_name: "revisions",
      sql: "CREATE UNIQUE INDEX `revisions_draft_id_revision_number_index` ON `revisions` (`draft_id`,`revision_number`)",
    },
    {
      tbl_name: "revisions",
      sql: "CREATE INDEX `revisions_review_status_index` ON `revisions` (`review_status`)",
    },
  ]);
});
