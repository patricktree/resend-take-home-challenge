# Resend send semantics

Type: research
Status: resolved
Blocked by: 

## Question

What does the Resend send-email API guarantee, and what does it offer for exactly-once sending? Cover: the `Idempotency-Key` header (scope, how long keys last, behaviour on a replay with the same or a different payload, behaviour on concurrent requests with the same key); error codes and which are safe to retry; rate limits; how the sending status of an email can be learned afterwards (response body, GET email, webhooks and their signatures); plain-text-only sends; the sandbox or test sender. Primary sources: resend.com docs and API reference, the official Node SDK.

## Answer

- `POST /emails` returns only `{ id }`. A 200 means "accepted", not "delivered". Plain-text-only sends work: give `text` without `html` (the SDK type requires at least one of `html`, `text` or `react`).
- `Idempotency-Key` takes 1 to 256 characters, is scoped to HTTP method + endpoint, and is kept for **24 hours**. A replay with the same body returns the original response and does not send again.
- The same key with a different body gives `409 invalid_idempotent_request`: do not retry unchanged. So retries must rebuild an identical body from stable data.
- The same key while the first request is still in flight gives `409 concurrent_idempotent_requests`: outcome unknown yet, safe to retry later.
- Safe to retry with the same key: 5xx (`application_error`, `service_unavailable`), network failures, `429 rate_limit_exceeded` (honour `retry-after`) and `409 concurrent_idempotent_requests`. Other 4xx and the quota 429s need a fix, not a retry.
- The rate limit is 10 req/s per team across all keys, with no burst allowance. The free plan allows 100 emails/day and 3,000/month, counting each recipient separately.
- Status afterwards: `GET /emails/{id}` gives `last_event` (sent, delivered, delivery_delayed, bounced, failed, suppressed, …). Webhooks (`email.sent`, `email.delivered`, `email.failed` with `data.failed.reason`, …) are signed with Svix / Standard Webhooks headers and verified on the raw body with `resend.webhooks.verify` (5-minute timestamp tolerance). Webhook delivery is retried and replayable, so it is at-least-once.
- The Node SDK (`resend` 6.34.1) never throws on API errors: it returns `{ data, error }`. It has no built-in retries; callers own the retry policy.
- Sandbox: `onboarding@resend.dev` sends only to the account owner's address. The `delivered@`, `bounced@`, `complained@` and `suppressed@resend.dev` test recipients simulate events and count against quota.
- Unknowns: whether keys are scoped per team or per API key; whether error responses are cached against a key; there is no lookup by idempotency key, so the email ID must be persisted; dedup beyond 24 h is entirely ours.

[findings](../research/resend-send-semantics.md)
