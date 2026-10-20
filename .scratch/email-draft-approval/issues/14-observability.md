# Observability

Type: grilling
Status: resolved
Blocked by: 07, 11, 13

## Question

What does v1 log about requests, verdicts and Sends, and in which shape? Settle: which events are logged (Submission, Approval, Rejection, superseded and already-decided verdict attempts, every Send attempt with its classification and next delay, reconciler ticks, DLQ handling, failed enqueues) and their fields (`requestId`, `draftId`, `revisionId`, attempt number, Resend status and error name, `delaySeconds`); structured JSON lines vs. plain text; whether Workers Logs (or Logpush, or nothing) is enabled in `wrangler.jsonc`; what must never be logged (tokens, recipient addresses, body); and whether any of it is asserted in tests. Audit trail needs beyond the demo and alerting are already Demo simplifications; this ticket only decides what v1 itself does.

## Comments

- Graduated from the map's "Not yet specified" after [13](13-testing-strategy.md) resolved.
- From [07](07-exactly-once-sending.md): attempt count, last Resend error and next attempt time live only in logs, not in the API. A failed inline enqueue is logged (the Approval still returns 200 `QUEUED`). `409 invalid_idempotent_request` is logged as an error because it means our own bug.
- From [07](07-exactly-once-sending.md) (already a Demo simplification, not this ticket's): the alert list for a real deployment is DLQ depth (always 0), queue backlog and oldest-message age (Queues metrics / GraphQL Analytics), Sends `QUEUED` for over 10 minutes, `FAILED` by `failureReason` (`OUTCOME_UNKNOWN` pages someone), Resend 429 rate and `x-resend-monthly-quota`.
- From [09](09-api-surface.md): every error envelope carries a `requestId`, which logs can use for correlation.
- From [06](06-approval-binding.md) and [10](10-agent-reviewer-separation.md): verdicts are not attributed to a person (single shared Reviewer token); the audit trail beyond the demo is covered by the SSO/IdP Demo simplification.
- From [13](13-testing-strategy.md): no CI, so nothing alerts on test failures either.

## Answer

Resolved by grilling with Patrick on 2026-10-20. Observability was not asked for by the challenge, so **v1 builds none**. The spec only notes what a real deployment would add, as a Demo simplifications entry.

### What v1 does

- **No observability configuration**: `wrangler.jsonc` has no `observability` block (no Workers Logs, no traces, no Logpush). Live debugging uses `wrangler tail`.
- **No event logging**: no event catalogue, no structured log fields, no logger helper.
- **Only a bare `console.error`** with the root-cause message (never Drizzle's wrapped error, which includes SQL parameters) on paths that already handle an error: a failed inline enqueue, `409 invalid_idempotent_request`, a DLQ message, and an unhandled 5xx.
- **`requestId` stays** as already decided: generated per request, carried in every error envelope ([09](09-api-surface.md)) and shown by the Review UI on unexpected errors ([12](12-review-ui.md)).
- **The audit trail is the D1 rows** as already specified (immutable Revisions, verdicts with `decidedAt` and reason, `approvedRevisionId`, the Send outcome). Nothing is added for v1.
- **No test asserts anything about logs.**

### For the spec

- Demo simplifications: **"No observability or alerting"** replaces 07's "no alerting" entry. *Demo:* no event logging beyond bare `console.error` on error paths, no metrics, no traces, no alerts. *Real deployment:*
  - structured JSON log events: Submission, verdicts recorded and refused, every Send attempt with its classification, Resend status and error name and next delay, Send resolutions by source (consumer, reconciler backstop, DLQ, deadline), reconciler ticks that did something, DLQ messages;
  - correlation by `requestId` per request and by `draftId` across the Send pipeline;
  - a never-log list: tokens, recipient addresses, subject, body, Rejection reason, Resend error messages, SQL parameters;
  - Workers Logs and traces, with Logpush or OTLP export for retention beyond the platform's few days;
  - metrics such as Sends by outcome and attempts per Send;
  - client-side error reporting for the Review UI;
  - the alerts from [07](07-exactly-once-sending.md): DLQ depth (always 0), queue backlog and oldest-message age, Sends `QUEUED` for more than 10 minutes, `FAILED` by `failureReason` (`OUTCOME_UNKNOWN` pages someone), Resend 429 rate and remaining quota (`x-resend-monthly-quota`).
- No separate Future increments entry.
- Revises [07](07-exactly-once-sending.md): attempt count, last Resend error and next attempt time are **not recorded in v1** (07 said "logs only"); "logged" for a failed enqueue and for `invalid_idempotent_request` means a bare `console.error`.
