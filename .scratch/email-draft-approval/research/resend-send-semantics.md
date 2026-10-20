# Research: Resend send semantics

Answers [issue 01](../issues/01-resend-send-semantics.md).
Sources were read on 2026-10-20: the Resend docs (Markdown versions under `https://resend.com/docs/*.md`) and the official Node SDK `resend` at npm version 6.34.1, GitHub `resend/resend-node` commit `7943103` (2026-10-16).

## Send Email endpoint

- `POST https://api.resend.com/emails`, authenticated with `Authorization: Bearer re_…`. Requests without a `User-Agent` header are rejected with 403 (the SDK sets one). [API intro](https://resend.com/docs/api-reference/introduction)
- Required body fields: `from`, `to` (string or array, max 50), `subject`. Optional fields include `cc`, `bcc`, `reply_to`, `html`, `text`, `headers`, `tags`, `scheduled_at`, `attachments`, `template`. [Send Email](https://resend.com/docs/api-reference/emails/send-email)
- Success response: `200` with body `{ "id": "<uuid>" }`. Nothing else, and no delivery status, is returned. [Send Email](https://resend.com/docs/api-reference/emails/send-email)
- There is no API versioning yet ("we plan to add versioning via calendar-based headers"). [API intro](https://resend.com/docs/api-reference/introduction)

## Plain-text-only sends

- `text` is "the plain text version of the message". If `text` is missing, Resend generates it from `html`. [Send Email](https://resend.com/docs/api-reference/emails/send-email)
- The docs don't say outright that `html` may be left out. The SDK type allows it: `CreateEmailOptions` is `RequireAtLeastOne<{ react, html, text }>`, so `{ from, to, subject, text }` type-checks. [create-email-options.interface.ts](https://github.com/resend/resend-node/blob/main/src/emails/interfaces/create-email-options.interface.ts)
- `GET /emails/:id` returns `html: null` or `text: null` for whichever part was not set. [Retrieve email](https://resend.com/docs/api-reference/emails/retrieve-email)
- Unknown: the exact MIME structure Resend produces for a text-only send (presumably a single `text/plain` part). This was not verified by sending one.

## `Idempotency-Key` header

Primary source: [Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys), plus the [Errors reference](https://resend.com/docs/api-reference/errors).

- **Endpoints:** `POST /emails` and `POST /emails/batch`, plus some Inbox endpoints. SMTP uses the `Resend-Idempotency-Key` email header.
- **Format:** 1 to 256 characters. Any other length gives `400 invalid_idempotency_key`. The docs recommend a UUID or an entity-derived key such as `<event-type>/<entity-id>` (their example is `welcome-user/123456789`).
- **Lifetime:** keys "are kept in the system for **24 hours**" and "expire after 24 hours". The docs don't say whether the 24 hours count from the first request or from its completion.
- **Replay with the same payload:** "our API will give the same response, without actually sending the email again". The success case returns the original email ID.
- **Replay with a different payload:** `409 invalid_idempotent_request`. The message is "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified". Retrying is "useless without changing the idempotency key or payload". The body is part of the match, so a replay must send a byte-equivalent (or at least semantically equal) body. The docs don't say which of the two counts as "modified".
- **Concurrent requests with the same key:** `409 concurrent_idempotent_requests`, "another request with the same idempotency key is in progress … it is safe to retry this request later". The second caller does not get the result. It has to retry until the first request finishes.
- **Scope:** the wording implies the key is scoped to HTTP method + endpoint ("used with this HTTP method and endpoint"). The docs don't say whether the scope is per team or per API key. Rate limits are per team, but that says nothing about keys.
- **Unknown:** whether a request that ended in an error (4xx validation, 429, 5xx) is recorded against the key, that is, whether a later retry replays the error or runs the send again. The docs only describe "has already been sent". The status codes involved are listed under "Errors and retry safety" below.
- **Unknown:** what happens after the 24 h window. The key is forgotten, so the same key with the same payload would presumably send again. The docs don't describe this case explicitly.

### Implications for "send at most once per key"

- Resend deduplicates only within 24 h. A Send retried later than that relies entirely on our own durable record (for example a stored email ID or a Send state).
- The key must be derived from something stable per Send (for example the Draft or the approved Revision). Every retry must rebuild the same body. If the Draft data is re-serialized in a different shape, the retry gets `409 invalid_idempotent_request` and not the original ID.
- A `409 concurrent_idempotent_requests` response means "unknown yet, retry". It does not mean "failed" and does not mean "sent".
- The email ID from the first success response is the only handle for later status lookups. Persist it.

## Errors and retry safety

From the [Errors reference](https://resend.com/docs/api-reference/errors) and [Usage Limits](https://resend.com/docs/api-reference/rate-limit). The "Retry?" column is Resend's own suggested action.

| Status    | Code                                                                                                                 | Resend's suggested action                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 400       | `invalid_idempotency_key`                                                                                            | fix the key (or omit it)                                              |
| 400       | `validation_error`                                                                                                   | fix the field named in the message                                    |
| 401       | `missing_api_key`, `restricted_api_key`, `validation_error` (invalid key on sending endpoints)                       | fix the credentials                                                   |
| 403       | `validation_error`: sandbox sender to a foreign recipient; unverified `from` domain; API key not active or suspended | fix the configuration                                                 |
| 404 / 405 | `not_found`, `method_not_allowed`                                                                                    | fix the request                                                       |
| 409       | `concurrent_idempotent_requests`                                                                                     | "Try the request again later"                                         |
| 409       | `invalid_idempotent_request`                                                                                         | do not retry unchanged                                                |
| 409       | `resource_locked`                                                                                                    | "Retry the request after a short delay" (resource updates, not sends) |
| 422       | `invalid_attachment`, `invalid_parameter`, `missing_required_field`, `missing_required_parameter`                    | fix the request                                                       |
| 429       | `rate_limit_exceeded`                                                                                                | back off (see `retry-after`)                                          |
| 429       | `daily_quota_exceeded`, `monthly_quota_exceeded`                                                                     | wait for the reset or upgrade; a short retry will not succeed         |
| 500       | `application_error`                                                                                                  | "Try the request again later"                                         |
| 503       | `service_unavailable`                                                                                                | "Try the request again later"                                         |

- The SDK's error-name union also lists `invalid_from_address`, `invalid_access`, `invalid_region`, `security_error` and `internal_server_error`, which the docs page does not cover. [interfaces.ts](https://github.com/resend/resend-node/blob/main/src/interfaces.ts)
- A 5xx or a network failure leaves the send outcome unknown. Retrying with the same key and the same body is the documented safe path, within 24 h.

## Rate limits and quotas

- The default is 10 requests per second **per team**, shared across all API keys. The window is per second with no burst allowance; the 11th request in that second gets 429. The limit can be raised on request. [Usage Limits](https://resend.com/docs/api-reference/rate-limit), [Quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- Response headers follow IETF draft-06: `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after`. Quota headers are `x-resend-daily-quota` (free plan only) and `x-resend-monthly-quota`.
- The free plan allows 100 emails/day (resetting at UTC midnight) and 3,000/month. Each `to`/`cc`/`bcc` recipient counts as one email, and received emails count too. Paid plans have no daily quota. Overage is capped at 5x the monthly quota. Test emails to `resend.dev` addresses also count. [Quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [Send Test Emails](https://resend.com/docs/dashboard/emails/send-test-emails)
- Unknown: whether a GET status lookup and a send share the same 10 rps pool. The docs say "requests", which implies all endpoints.

## Learning the sending status afterwards

1. **Send response:** the ID only. A 200 means the request was accepted, not that the email was delivered.
2. **`GET /emails/{id}`:** returns the email with `last_event`, one of `bounced`, `canceled`, `clicked`, `complained`, `delivered`, `delivery_delayed`, `failed`, `opened`, `queued`, `scheduled`, `sent`, `suppressed`. It returns only the latest event, not the history. [Retrieve email](https://resend.com/docs/api-reference/emails/retrieve-email), [event meanings](https://resend.com/docs/dashboard/emails/manage-emails#understand-email-events), [SDK type](https://github.com/resend/resend-node/blob/main/src/emails/interfaces/get-email-options.interface.ts)
   - `sent`: "The email was sent successfully" (the API request succeeded and Resend will try to deliver).
   - `delivered`: the recipient's mail server accepted it.
   - `delivery_delayed`: Resend retries for up to 14 h and then marks the email `bounced`.
   - `failed`: the send failed, with reasons such as quota, domain or API key problems.
   - `suppressed`: the recipient is on the suppression list and nothing was sent.
   - Unknown: no documented lookup by idempotency key. If the ID was never received (crash after the send), the only way back to it is a 24 h replay with the same key and body. Listing emails (`GET /emails`, paginated) does not document a filter by key or tag.
3. **Webhooks:** you register an HTTPS endpoint and choose event types (`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `email.opened`, `email.clicked`, `email.scheduled`, …). [Event types](https://resend.com/docs/webhooks/event-types)
   - The payload is `{ type, created_at, data: { email_id, message_id, from, to, subject, tags, created_at, … } }`. `email.failed` adds `data.failed.reason` (for example `reached_daily_quota`). Tags come back as an object, so they can carry a correlation ID. [email.sent](https://resend.com/docs/webhooks/emails/sent), [email.failed](https://resend.com/docs/webhooks/emails/failed)
   - Delivery is retried with backoff: immediately, then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h. Endpoints that keep failing are disabled automatically. Messages can be replayed manually, including ones that succeeded. In effect this is at-least-once delivery, so handlers must be idempotent. Event ordering is not documented. [Retries and Replays](https://resend.com/docs/webhooks/retries-and-replays)
   - **Signatures:** Svix-style headers `svix-id`, `svix-timestamp` and `svix-signature` (`v1,<base64 HMAC>`), plus a per-endpoint signing secret. The signing secret is also returned by the webhook create, get and list API calls. Verify against the **raw** body. [Verify webhooks](https://resend.com/docs/webhooks/verify-webhooks-requests)
   - `resend.webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret })` in the SDK wraps the `standardwebhooks@1.1.1` `Webhook.verify`. It maps the values to `webhook-id`, `webhook-timestamp` and `webhook-signature` (the same scheme as Svix) and rejects timestamps more than 5 minutes off. It throws if verification fails and otherwise returns the typed payload. [webhooks.ts](https://github.com/resend/resend-node/blob/main/src/webhooks/webhooks.ts), standardwebhooks `dist/index.js` (`WEBHOOK_TOLERANCE_IN_SECONDS = 5 * 60`)
   - The docs mention replay attacks but don't specify deduplication. The `svix-id` value is the natural dedup key; this is inferred from the Svix scheme, not stated by Resend.

## Official Node SDK (`resend` 6.34.1)

- `resend.emails.send(payload, { idempotencyKey })` sets the `Idempotency-Key` header. [resend.ts `post`](https://github.com/resend/resend-node/blob/main/src/resend.ts)
- **It never throws on API errors.** It returns `{ data, error, headers }` with `error: { name, message, statusCode }`. A network failure gives `name: 'application_error', statusCode: null`. A non-JSON error body gives `application_error` with the HTTP status. When `NODE_ENV !== 'production'`, errors are also printed with `console.error`. [resend.ts `fetchRequest`](https://github.com/resend/resend-node/blob/main/src/resend.ts)
- **No built-in retries or backoff.** No retry logic exists in `src/`, and the only mention of "retry" is the doc comment on `idempotencyKey`. Callers own retry policy.
- It uses global `fetch` and accepts `baseUrl` and `userAgent` options. Runtime dependencies are `postal-mime` and `standardwebhooks`, and `@react-email/render` is an optional peer used only for `react`. Resend has an official [Cloudflare Workers guide](https://resend.com/docs/send-with-cloudflare-workers) that uses this package.

## Sandbox and test sender

- **Sandbox sender:** `onboarding@resend.dev` works without a verified domain, but "can only send emails to the email address associated with your Resend account". Any other recipient gets `403 validation_error`. [403 resend.dev](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)
- **Test recipients:** `delivered@resend.dev`, `bounced@resend.dev` (SMTP 550 5.1.1), `complained@resend.dev` and `suppressed@resend.dev` simulate those events, including webhooks. The first three accept `+label` (for example `delivered+draft-123@resend.dev`); `suppressed` does not. These sends count against quota. [Send Test Emails](https://resend.com/docs/dashboard/emails/send-test-emails)
- The docs' own examples send from `onboarding@resend.dev` to `delivered@resend.dev`, which implies the sandbox sender may address the test recipients. That is inferred from the examples, not stated as a rule.
- No separate test-mode API key or offline mock endpoint is documented. Tests that must not touch the network need a stub behind `baseUrl` or a fake client.

## Resend's own reliability guidance

Added 2026-10-20 during [ticket 07](../issues/07-exactly-once-sending.md), from the [sending-reliability reference](https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/references/sending-reliability.md) in Resend's `resend-skills` repository.

- Idempotency keys: prefer event-based keys (one email per business event); every retry of the same logical send reuses the key; finish all retries well within the 24 h key lifetime.
- Retry 5xx, 429, network timeouts and DNS failures; do not retry other 4xx (fix the request first).
- Backoff example: start at 1 s, double, cap at 30 s, up to 1 s of random jitter, 5 attempts by default. This is in-process retrying; for 429 the example hands `retryAfter` to a queue, and the text says to wait for the rate-limit window.
- For critical emails, persist sends in a queue: save as pending, attempt, mark sent with the message ID, count and schedule retries, mark failed and alert on permanent failure.
- Timeout: 10 to 30 s per API call (the example uses a 10 s `AbortSignal`).

## Batch sending (`POST /emails/batch`)

Added 2026-10-20 during [ticket 07](../issues/07-exactly-once-sending.md), from [Send Batch Emails](https://resend.com/docs/api-reference/emails/send-batch-emails).

- Up to 100 emails per call; the response `data` is an array of `{ id }` matching the request order. `tags` and `scheduled_at` are supported; `attachments` are not.
- The `Idempotency-Key` header is per request ("Should be unique per API request"), expires after 24 h, max 256 characters. No per-email key is documented.
- Not documented: what happens when one email in the batch is invalid (whole request or per email), per-email error reporting, and whether a batch counts as one request against the rate limit.
- Consequence for this project: independent per-Draft Sends with their own retries cannot share a batch key, so ticket 07 sends one `POST /emails` per Draft.

## Open unknowns (summary)

- Whether the idempotency scope is the team or the API key.
- Whether failed (4xx/5xx/429) responses are stored against a key and replayed.
- Whether the 24 h window starts at the first request or at completion. Whether "payload modified" compares raw bytes or parsed JSON.
- Whether a status lookup by idempotency key or tag is possible (none is documented).
- Webhook event ordering guarantees (none documented).
