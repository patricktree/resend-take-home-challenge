# 08: Send through Resend

**What to build:** An approved Draft is sent through Resend exactly once and ends `SENT` with its email id, or `FAILED` with a reason, despite redeliveries, retries and overlapping attempts. Spec: [Send pipeline](../../email-draft-approval/spec.md#9-send-pipeline), [Resend stub](../../email-draft-approval/spec.md#resend-stub), [Live Resend contract test](../../email-draft-approval/spec.md#live-resend-contract-test).

**Blocked by:** 06 (Approve and reject)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/10>)

- [x] Queue consumer is the only code calling Resend: plain `fetch` to `RESEND_BASE_URL` with `Idempotency-Key` and exactly the frozen email (`text` from the R2 body), 10 s timeout, one `POST /emails` per Draft
- [x] Classification table and backoff (1 s × 2^(attempts−1), 1 h cap, jitter, `Retry-After` wins, clamped to the deadline) as in the spec; unit-tested
- [x] Past the 23 h deadline: `FAILED` / `OUTCOME_UNKNOWN` without calling Resend
- [x] Conditional outcome writes; `sending` (`emailId`, `failure`) on Draft responses
- [x] Pacing: a batch's calls start together and the invocation lasts at least 1.0 s (one real-time test)
- [x] Resend stub (`node:http`, per test) modelling idempotency, with per-test overrides; Send Queue batches delivered through the test entry point's RPC method `deliverSendQueueBatch()`, outside the production build; one test proves real Miniflare delivery from an Approval to the consumer
- [x] Scenarios: every classification row, duplicate concurrent delivery (stub holds the request; one ledger email, retry after `409 concurrent_idempotent_requests`), deadline; "exactly one email per approved Draft with the frozen body" asserted throughout
- [x] Opt-in `pnpm test:resend-live` contract test against the real API (not part of validation); implemented, not run (needs a real `RESEND_API_KEY`)
