CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_action_at` integer NOT NULL,
	`latest_revision_id` text NOT NULL,
	`sending_status` text DEFAULT 'NOT_SENT' NOT NULL,
	`approved_revision_id` text,
	`approved_at` integer,
	`idempotency_key` text,
	`outgoing_email` text,
	`deadline` integer,
	`enqueued_at` integer,
	`email_id` text,
	`failure_reason` text,
	`resend_error_name` text,
	`resend_error_message` text,
	CONSTRAINT "drafts_sending_status_values" CHECK("drafts"."sending_status" IN ('NOT_SENT', 'QUEUED', 'SENT', 'FAILED')),
	CONSTRAINT "drafts_failure_reason_values" CHECK("drafts"."failure_reason" IS NULL OR "drafts"."failure_reason" IN ('REJECTED_BY_RESEND', 'OUTCOME_UNKNOWN')),
	CONSTRAINT "drafts_not_sent_exactly_without_approval" CHECK(("drafts"."sending_status" = 'NOT_SENT') = ("drafts"."approved_revision_id" IS NULL)),
	CONSTRAINT "drafts_approved_revision_is_latest" CHECK("drafts"."approved_revision_id" IS NULL OR "drafts"."approved_revision_id" = "drafts"."latest_revision_id"),
	CONSTRAINT "drafts_outbox_complete_exactly_with_approval" CHECK(("drafts"."approved_at" IS NULL) = ("drafts"."approved_revision_id" IS NULL)
        AND ("drafts"."idempotency_key" IS NULL) = ("drafts"."approved_revision_id" IS NULL)
        AND ("drafts"."outgoing_email" IS NULL) = ("drafts"."approved_revision_id" IS NULL)
        AND ("drafts"."deadline" IS NULL) = ("drafts"."approved_revision_id" IS NULL)),
	CONSTRAINT "drafts_email_id_exactly_when_sent" CHECK(("drafts"."email_id" IS NOT NULL) = ("drafts"."sending_status" = 'SENT')),
	CONSTRAINT "drafts_failure_reason_exactly_when_failed" CHECK(("drafts"."failure_reason" IS NOT NULL) = ("drafts"."sending_status" = 'FAILED')),
	CONSTRAINT "drafts_resend_error_only_when_rejected_by_resend" CHECK("drafts"."failure_reason" IS 'REJECTED_BY_RESEND'
        OR ("drafts"."resend_error_name" IS NULL AND "drafts"."resend_error_message" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `drafts_created_at_id_index` ON `drafts` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `drafts_last_action_at_id_index` ON `drafts` (`last_action_at`,`id`);--> statement-breakpoint
CREATE INDEX `drafts_queued_not_enqueued_approved_at_index` ON `drafts` (`approved_at`) WHERE "drafts"."sending_status" = 'QUEUED' AND "drafts"."enqueued_at" IS NULL;--> statement-breakpoint
CREATE INDEX `drafts_queued_deadline_index` ON `drafts` (`deadline`) WHERE "drafts"."sending_status" = 'QUEUED';--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`created_at` integer NOT NULL,
	`to_addresses` text NOT NULL,
	`subject` text NOT NULL,
	`review_status` text NOT NULL,
	`submitted_at` integer,
	`decided_at` integer,
	`rejection_reason` text,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "revisions_review_status_values" CHECK("revisions"."review_status" IN ('UNSUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
	CONSTRAINT "revisions_submitted_at_matches_review_status" CHECK("revisions"."review_status" = 'SUPERSEDED'
        OR ("revisions"."review_status" = 'UNSUBMITTED' AND "revisions"."submitted_at" IS NULL)
        OR ("revisions"."review_status" IN ('PENDING', 'APPROVED', 'REJECTED') AND "revisions"."submitted_at" IS NOT NULL)),
	CONSTRAINT "revisions_decided_at_exactly_with_verdict" CHECK(("revisions"."decided_at" IS NOT NULL) = ("revisions"."review_status" IN ('APPROVED', 'REJECTED'))),
	CONSTRAINT "revisions_rejection_reason_only_when_rejected" CHECK("revisions"."rejection_reason" IS NULL OR "revisions"."review_status" = 'REJECTED')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_draft_id_revision_number_index` ON `revisions` (`draft_id`,`revision_number`);--> statement-breakpoint
CREATE INDEX `revisions_review_status_index` ON `revisions` (`review_status`);