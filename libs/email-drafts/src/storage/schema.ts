/*
 * The D1 schema (spec section 5). Timestamps are integer milliseconds since the Unix epoch.
 * `drizzle-kit generate` turns the schema into the SQL migrations in `../../migrations/`, so every
 * change here needs `pnpm --filter '@resend-challenge/email-drafts' migrations:generate`.
 *
 * SQLite passes a CHECK whose expression is NULL, so the constraints compare nullable columns with
 * `IS` rather than `=`.
 */

import { sql, type SQL } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import {
  FAILURE_REASONS,
  REVIEW_STATUSES,
  SENDING_STATUSES,
  type OutgoingEmail,
} from "../domain/draft.ts";
import type { DraftId, RevisionId } from "../domain/ids.ts";

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey().$type<DraftId>(),
    createdAt: integer("created_at").notNull(),
    /** Set by create, revise, submit and verdict; never by a Send outcome. */
    lastActionAt: integer("last_action_at").notNull(),
    /** No foreign key: the Draft row is inserted before its first Revision. */
    latestRevisionId: text("latest_revision_id").notNull().$type<RevisionId>(),
    sendingStatus: text("sending_status", { enum: SENDING_STATUSES }).notNull().default("NOT_SENT"),
    /* The outbox, written by the Approval. */
    approvedRevisionId: text("approved_revision_id").$type<RevisionId>(),
    approvedAt: integer("approved_at"),
    idempotencyKey: text("idempotency_key"),
    outgoingEmail: text("outgoing_email", { mode: "json" }).$type<OutgoingEmail>(),
    deadline: integer("deadline"),
    /** Set once the Send's Queue message has been sent. */
    enqueuedAt: integer("enqueued_at"),
    /* The Send outcome. */
    emailId: text("email_id"),
    failureReason: text("failure_reason", { enum: FAILURE_REASONS }),
    resendErrorName: text("resend_error_name"),
    resendErrorMessage: text("resend_error_message"),
  },
  (table) => [
    check(
      "drafts_sending_status_values",
      sql`${table.sendingStatus} IN ${sqlValueList(SENDING_STATUSES)}`,
    ),
    check(
      "drafts_failure_reason_values",
      sql`${table.failureReason} IS NULL OR ${table.failureReason} IN ${sqlValueList(FAILURE_REASONS)}`,
    ),
    check(
      "drafts_not_sent_exactly_without_approval",
      sql`(${table.sendingStatus} = 'NOT_SENT') = (${table.approvedRevisionId} IS NULL)`,
    ),
    // An approved Draft gets no newer Revision.
    check(
      "drafts_approved_revision_is_latest",
      sql`${table.approvedRevisionId} IS NULL OR ${table.approvedRevisionId} = ${table.latestRevisionId}`,
    ),
    check(
      "drafts_outbox_complete_exactly_with_approval",
      sql`(${table.approvedAt} IS NULL) = (${table.approvedRevisionId} IS NULL)
        AND (${table.idempotencyKey} IS NULL) = (${table.approvedRevisionId} IS NULL)
        AND (${table.outgoingEmail} IS NULL) = (${table.approvedRevisionId} IS NULL)
        AND (${table.deadline} IS NULL) = (${table.approvedRevisionId} IS NULL)`,
    ),
    check(
      "drafts_email_id_exactly_when_sent",
      sql`(${table.emailId} IS NOT NULL) = (${table.sendingStatus} = 'SENT')`,
    ),
    check(
      "drafts_failure_reason_exactly_when_failed",
      sql`(${table.failureReason} IS NOT NULL) = (${table.sendingStatus} = 'FAILED')`,
    ),
    check(
      "drafts_resend_error_only_when_rejected_by_resend",
      sql`${table.failureReason} IS 'REJECTED_BY_RESEND'
        OR (${table.resendErrorName} IS NULL AND ${table.resendErrorMessage} IS NULL)`,
    ),
    // List ordering and cursor paging.
    index("drafts_created_at_id_index").on(table.createdAt, table.id),
    index("drafts_last_action_at_id_index").on(table.lastActionAt, table.id),
    // Send reconciler job 1: approved Drafts whose Queue message was never sent.
    index("drafts_queued_not_enqueued_approved_at_index")
      .on(table.approvedAt)
      .where(sql`${table.sendingStatus} = 'QUEUED' AND ${table.enqueuedAt} IS NULL`),
    // Send reconciler job 2: queued Drafts past their deadline.
    index("drafts_queued_deadline_index")
      .on(table.deadline)
      .where(sql`${table.sendingStatus} = 'QUEUED'`),
  ],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey().$type<RevisionId>(),
    draftId: text("draft_id")
      .notNull()
      .$type<DraftId>()
      .references(() => drafts.id),
    /** 1-based per Draft. */
    revisionNumber: integer("revision_number").notNull(),
    createdAt: integer("created_at").notNull(),
    toAddresses: text("to_addresses", { mode: "json" }).notNull().$type<string[]>(),
    subject: text("subject").notNull(),
    reviewStatus: text("review_status", { enum: REVIEW_STATUSES }).notNull(),
    submittedAt: integer("submitted_at"),
    decidedAt: integer("decided_at"),
    rejectionReason: text("rejection_reason"),
  },
  (table) => [
    check(
      "revisions_review_status_values",
      sql`${table.reviewStatus} IN ${sqlValueList(REVIEW_STATUSES)}`,
    ),
    // A Superseded Revision may or may not have been submitted.
    check(
      "revisions_submitted_at_matches_review_status",
      sql`${table.reviewStatus} = 'SUPERSEDED'
        OR (${table.reviewStatus} = 'UNSUBMITTED' AND ${table.submittedAt} IS NULL)
        OR (${table.reviewStatus} IN ('PENDING', 'APPROVED', 'REJECTED') AND ${table.submittedAt} IS NOT NULL)`,
    ),
    check(
      "revisions_decided_at_exactly_with_verdict",
      sql`(${table.decidedAt} IS NOT NULL) = (${table.reviewStatus} IN ('APPROVED', 'REJECTED'))`,
    ),
    check(
      "revisions_rejection_reason_only_when_rejected",
      sql`${table.rejectionReason} IS NULL OR ${table.reviewStatus} = 'REJECTED'`,
    ),
    uniqueIndex("revisions_draft_id_revision_number_index").on(table.draftId, table.revisionNumber),
    // List filters join `drafts.latest_revision_id` to `revisions.id` and filter on this column.
    index("revisions_review_status_index").on(table.reviewStatus),
  ],
);

/** Renders constant string values as an SQL list literal, such as `('A', 'B')`. */
function sqlValueList(values: readonly string[]): SQL {
  return sql.raw(`(${values.map((value) => `'${value}'`).join(", ")})`);
}
