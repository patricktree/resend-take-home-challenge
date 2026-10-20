# 06: Approve and reject

**What to build:** The Reviewer approves or rejects exactly the Revision they loaded. An Approval records exactly one Send intent and hands it to the Send Queue; Agents can never render a verdict. Nothing consumes the Queue yet. Spec: [Approval binding and concurrency](../../email-draft-approval/spec.md#8-approval-binding-and-concurrency), [Approval and hand-off](../../email-draft-approval/spec.md#approval-and-hand-off), [Roles](../../email-draft-approval/spec.md#roles).

**Blocked by:** 04 (Submit a Revision)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/9>)

- [x] `POST …/approval` (empty body) and `POST …/rejection` (optional `reason`, 1–2000 chars after trimming, empty = absent), both behind `requireReviewer` before any database access → 403 `REVIEWER_ONLY` for the Agent token
- [x] Guarded verdict batches on "latest and `PENDING`"; errors `REVISION_SUPERSEDED`, `REVISION_ALREADY_DECIDED` (with `existingVerdict`, also for a repeated identical verdict), `REVISION_NOT_SUBMITTED`
- [x] The Approval batch sets `QUEUED` and freezes `approved_revision_id`, `approved_at`, `idempotency_key`, `outgoing_email` (with `from` from `RESEND_FROM` and the `draft_id` tag) and `deadline`; then `queue.send` and conditional `enqueued_at`; a failed enqueue still returns 200 `QUEUED` and `console.error`s
- [x] `lastVerdict` on Draft responses; Revise after a Rejection builds on the rejected Revision; Revise and Submit on an approved Draft → `DRAFT_APPROVED`
- [x] Every verdict race from the spec (approve ‖ approve, approve ‖ reject, verdict ‖ revise) deterministic and as a 10-concurrent-requests smoke test: one 200, correct 409s, one Queue message; losers leave rows unchanged
- [x] Route-table test: exactly the two verdict routes are Reviewer-only; OpenAPI lists only `reviewerAuth` on them; snapshot updated
- [x] `pnpm seed` creates Pending, Rejected and Approved Drafts locally through the typed client
