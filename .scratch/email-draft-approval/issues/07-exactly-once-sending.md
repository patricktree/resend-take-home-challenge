# Sending exactly once

Type: grilling
Status: resolved
Blocked by: 01, 03, 05

## Question

How is an approved Revision sent through Resend exactly once, despite repeated approvals, concurrent approvals, repeated send retries and concurrent send retries? Settle: who triggers a retry (the system on its own, the Agent, the Reviewer); how the intent to send is recorded (outbox, queue, workflow, durable object); which idempotency key is used and how long it must hold compared to Resend's key lifetime; how the sending status is learned and recorded; what happens on permanent failure.

## Comments

- From [05](05-draft-lifecycle.md): the Approval triggers the Send automatically; no Agent or Reviewer send or retry operation exists, so retries are system-driven only. Sending status is `NOT_SENT` → `QUEUED` → `SENT` (with Resend email ID) | `FAILED`; `FAILED` is terminal and the Draft stays closed. Still to settle here: what counts as permanent and how many retries come first. Delivery events are out of v1.
- From [06](06-approval-binding.md): the Approval writes `approvedRevisionId` onto the Draft in the same transaction that sets sending status to `QUEUED`; the Send builds the email only from that Revision. Repeated or concurrent verdicts are rejected by the conditional UPDATE (`REVISION_ALREADY_DECIDED`), so at most one Approval ever triggers the Send; `from` is read from configuration at Send time.
- Revised by [15](15-spec-assembly.md): the production Queue consumer also sets `max_batch_timeout: 1`; Resend statuses outside the classification table are classified as follows: any other 4xx (including a 409 with an unknown name) is final `REJECTED_BY_RESEND`, any other status or a 2xx without an `id` is retryable. [spec.md](../spec.md) is authoritative.

## Answer

Resolved by grilling with Patrick on 2026-10-20. All options considered (A–K) and their trade-offs are in [research/send-topology-options.md](../research/send-topology-options.md); the decision is **option C**.

### Topology (option C)

- **D1 is the single source of truth** for Drafts, Revisions, verdicts and the Send record. The outbox is a set of columns on the Draft row, not a separate store.
- **R2 holds every Revision's body** at `revisions/<revisionId>/body`, written before the D1 commit that creates the Revision; `to` and `subject` stay in D1. A failed commit leaves a harmless orphan object.
- **One Queue** carries Send attempts. Its **consumer is the only code that calls Resend** and the only retry clock.
- **A reconciler cron** (every minute), the **Send reconciler**, recovers lost hand-offs and resolves stuck Sends.
- **A DLQ consumer** resolves messages that exhausted their retries.
- Rejected alternatives in short: one DO per Draft with a D1 read model (B) buys write locality but costs an eventually consistent list, a projection as the only catalog and per-object migrations; a singleton Sender DO (J) or a cron-only sender (A) was simpler but put Resend calls in the scheduler loop or had no central pacing. B is named in the spec as the path if per-Draft write locality ever matters.

### Approval and hand-off

1. The verdict is one D1 `batch()` (conditional, per [06](06-approval-binding.md)) that records the Approval, writes `approvedRevisionId`, sets sending status `QUEUED`, and freezes:
   - `idempotencyKey = draft-send/<draftId>`;
   - `outgoingEmail = { from, to, subject, bodyKey, tags: { draft_id } }`, with `from` resolved from configuration **at Approval time** (refines 06, which said "at Send time");
   - `deadline = approvedAt + 23 h`.
2. The same request then calls `queue.send({ draftId, idempotencyKey, outgoingEmail, deadline })` and records `enqueuedAt`.
3. A failed enqueue never fails the Approval: the verdict is committed, the response is 200 with `QUEUED`, the failure is logged, and the Send reconciler picks it up.
4. The verdict response returns the D1 Sessions bookmark; the typed client sends it with later reads, so the Reviewer's next list read already reflects the verdict (read-your-writes). No UI-side hiding.

### Consumer

- If the frozen deadline has passed, it records `FAILED` / `OUTCOME_UNKNOWN` without calling Resend.
- Otherwise it reads the body from R2 and calls `POST /emails` with the `Idempotency-Key` and exactly the frozen `outgoingEmail` (10 s timeout).
- One `POST /emails` per Draft, never `POST /emails/batch`: the batch endpoint takes one idempotency key per request, not per email, and Queue batches are not stable across retries, so a retried batch could neither reuse its key (different body → `409 invalid_idempotent_request`) nor safely use a new one (duplicate emails). Its partial-failure behavior is also undocumented, and human-gated volume gains nothing from it.
- On a final result it records the outcome in D1 (conditional write) and acks; on a retryable result it calls `message.retry({ delaySeconds })`.
- Pacing: `max_concurrency: 1`, `max_batch_size: 8`; each invocation starts its batch's Resend calls together and lasts at least 1.0 s, which keeps the system at about 8 requests per second, under Resend's 10 per second per team. A 429 that still slips through is simply retried.
- `max_retries: 100`, well above the roughly 35 attempts that fit before the deadline, so only crash loops reach the DLQ.

### Classification and backoff

- **Permanent** (`FAILED` / `REJECTED_BY_RESEND`, with Resend's error name and message): 400, 401, 403, 404, 405, 422, and `409 invalid_idempotent_request` (also logged as an error, since it means our own bug).
- **Retryable:** `409 concurrent_idempotent_requests`, 408, 429 (rate limit and quota), 5xx, network errors, the 10 s timeout.
- **Backoff for every retryable result:** delay = max(backoff, `Retry-After` if present), where backoff starts at 1 s, doubles, is capped at 1 h and gets up to 1 s of jitter; the result is clamped to the deadline. That is about 35 attempts within 23 h.
- A 1-second start follows Resend's own guidance ([sending-reliability](https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/references/sending-reliability.md): start at 1 s, double, add jitter) so a one-off 5xx or timeout costs seconds, not minutes; the 1-hour cap and the deadline let the same schedule ride out a long outage. Honoring `Retry-After` keeps a retry from landing inside Resend's rate-limit window. (An earlier round chose a 1-minute start and ignored `Retry-After`; both were revised after reading that reference.)

### The 23 h deadline

- **No Resend call is ever made later than `approvedAt + 23 h`.** Resend keeps idempotency keys for only 24 h; after that, the same key and body would send a second email. The first call cannot happen before `approvedAt`, so every call stays inside the window with an hour of margin.
- A Send still unresolved at the deadline becomes `FAILED` / `OUTCOME_UNKNOWN`. The spec must state this rule explicitly.

### Send reconciler (cron, every minute)

Two jobs only, both bounded:

1. Re-enqueue Sends that are `QUEUED`, have no `enqueuedAt` and were approved more than 1 min ago (lost hand-off).
2. Record `FAILED` / `OUTCOME_UNKNOWN` for Sends still `QUEUED` at `deadline + 1 h` (backstop for a message lost after the hand-off, e.g. by retention expiry).

- Each job handles at most 100 rows per tick, oldest first, enqueued with one `sendBatch`; the tick stops at the first enqueue failure, so a Queues outage is not hammered and the backlog drains over later ticks.
- Partial indexes keep both queries proportional to the backlog, not the table: `approved_at` where `QUEUED` and `enqueued_at IS NULL`; `deadline` where `QUEUED`.
- Duplicates (a request that died between `queue.send` and setting `enqueuedAt`, overlapping ticks) are absorbed by the idempotency key.
- Message retention stays at or above the default 4 days, never below 24 h.

### DLQ consumer

- Records `FAILED` / `OUTCOME_UNKNOWN` for each message and acks. The reconciler's backstop makes the DLQ non-essential for correctness; it is the fast path.

### Sending status and outcomes

- Sending status stays `NOT_SENT` → `QUEUED` → `SENT` | `FAILED` (from [05](05-draft-lifecycle.md)).
- `SENT` carries the Resend email ID and is learned **only** from a 200 response to the send, including a replay of the same key, which returns the original ID. No `GET /emails/{id}` and no webhooks in v1.
- `FAILED` carries `failureReason`: `REJECTED_BY_RESEND` (definitely not sent; with Resend's error name and message) or `OUTCOME_UNKNOWN` (may have been sent; check the Resend dashboard before creating a new Draft).
- Outcome writes are conditional: the first final outcome wins, except that a later `SENT` overrides `FAILED` / `OUTCOME_UNKNOWN`. This is the only exception to "`FAILED` is terminal" from 05; nothing else ever leaves `SENT` or `FAILED`.
- The API exposes sending status, the email ID when `SENT`, and `failureReason` when `FAILED`. Attempt count, last error and next attempt time go to logs only.

### Why this sends at most once and at least once (within the deadline)

- Repeated and concurrent verdicts: only one conditional `UPDATE` succeeds (06), so only one Send intent is ever recorded.
- Repeated and concurrent attempts (Queue redelivery, reconciler re-enqueue, overlapping consumers after a crash): every attempt sends the same frozen body with the same key within 24 h of the first, so Resend returns the original ID or `409 concurrent_idempotent_requests` (retried), never a second email.
- Lost hand-off or lost message: the reconciler re-enqueues or, at the latest at `deadline + 1 h`, resolves the Send. Nothing stays `QUEUED` forever.

### Reads

- List reads use D1 read replicas through the Sessions API. Clients that pass a bookmark get read-your-writes; others may see a just-submitted or just-decided Draft with a short delay. Decisions never rely on replica reads: verdicts and outcome writes are conditional writes on the primary.
- The CLI and the MCP server keep no bookmark between calls, so their reads may be briefly stale. Accepted for v1.

### For the spec

- Demo simplifications: no alerting. A real deployment alerts on DLQ depth (always 0), queue backlog and oldest-message age, Sends `QUEUED` for more than 10 minutes, `FAILED` by `failureReason` (`OUTCOME_UNKNOWN` pages someone), Resend 429 rate and remaining quota (`x-resend-monthly-quota`).
- Future increments: delivery tracking via webhooks or `GET /emails/{id}` also resolves `OUTCOME_UNKNOWN` Sends, matched by the `draft_id` tag (included in `outgoingEmail` now because adding it later would change the frozen body); persist the D1 bookmark in the CLI and the MCP session for read-your-writes; per-Draft Durable Objects (option B) if write locality or write throughput ever matter.
- Known limitation: CLI and MCP list reads may be briefly stale.
- Deployment note: one Resend team for this system alone, since the rate limit is per team.
