# Testing strategy

Type: grilling
Status: resolved
Blocked by: 11, 12

## Question

Which tests prove the system's guarantees, and at which level? Settle the integration scenarios that prove the concurrency and exactly-once guarantees (concurrent approvals, revise-vs-verdict races, concurrent and duplicate Send attempts), the Send pipeline cases, the API and auth contract tests, the e2e coverage of the review flow, and what stays a unit test. Priorities from the map's Notes: integration first, e2e second, unit third; Vitest and Playwright.

## Comments

- Graduated from the map's "Not yet specified" when [11](11-cloudflare-app-structure.md) settled the test mechanics.
- From [07](07-exactly-once-sending.md): duplicate Queue deliveries, a lost hand-off picked up by the Send reconciler cron, the 23 h deadline and the `deadline + 1 h` backstop, the DLQ path, outcome races (a late `SENT` after `OUTCOME_UNKNOWN`), and a Resend stub returning 409 (`concurrent_idempotent_requests` vs `invalid_idempotent_request`), 429 with `Retry-After`, 5xx and timeouts; the pacing (batch of 8, at least 1 s per invocation).
- From [06](06-approval-binding.md) and [09](09-api-surface.md): every 409 code (`REVISION_SUPERSEDED`, `REVISION_ALREADY_DECIDED` with `existingVerdict`, `REVISION_NOT_SUBMITTED`, `REVISION_ALREADY_SUBMITTED`, `DRAFT_APPROVED`), `baseRevisionId` on revise, the limits (50 recipients, 998-char subject, 100 KB body, 128 KB request → 413), cursor paging, the OpenAPI snapshot test, read-your-writes through `X-Read-Bookmark`.
- From [10](10-agent-reviewer-separation.md): the Agent token gets 403 `REVIEWER_ONLY` on both verdict routes and the Draft stays `PENDING` / `NOT_SENT`; a route-table test that exactly those two routes are Reviewer-only; `/mcp` answers the Reviewer token with 403 `AGENT_ONLY`; MCP `tools/list` has no verdict tool; local tokens are rejected without the local flag or on a non-local host.
- From [11](11-cloudflare-app-structure.md), the mechanics are fixed:
  - integration tests run the whole Worker in Wrangler's local test runtime (`createTestHarness`) from `apps/cloudflare-worker/test/`, with `wrangler.test.jsonc`, `applyD1Migrations()`, `worker.fetch` and `worker.scheduled()`;
  - consumer scenarios go through the test-only routes `POST /__test/queue` / `POST /__test/dlq` in `test/worker.ts`, which call the real `queue()` handler with a synthesized `MessageBatch` and report ack / retry / `delaySeconds`; one test checks real Miniflare delivery from an Approval to the consumer;
  - Resend is a `node:http` stub on an OS-assigned port, scripted per test;
  - `libs/email-drafts` has its own smaller suite for races easier to pin down without HTTP;
  - e2e: the built Worker under `wrangler dev` on an OS-assigned port, Playwright in cup's Docker image, local tokens accepted on `host.docker.internal`;
  - the `/app` security headers and SPA fallback are asserted by an integration test.
- Open for this ticket: how to make two conditional writes actually race in the local runtime (concurrent `fetch` calls vs. interleaving at the D1 level), whether to use screenshot baselines like cup, and whether the CLI gets cup's spawn-the-real-process test against a stub.
- From [12](12-review-ui.md): the review flow has no dialogs, toasts or keyboard shortcuts, so e2e coverage is the following. Token screen: an `agent_` token is refused client-side; a wrong token returns to the token screen on 401; a `reviewUrl` deep link opened without a token lands on its Draft after the token is entered; Sign out. Pending list → Draft page → Approve, sending status goes from "Sending…" to "Sent" (the page polls every 3 s while `QUEUED`, so the consumer must run in the e2e setup or the test drives `/__test/queue`). Reject with and without a reason. `REVISION_SUPERSEDED` (the Agent revises after the page loaded) and `REVISION_ALREADY_DECIDED` render inline with "Reload Draft", and nothing is re-applied. Unsubmitted Draft ("Not submitted for review yet", no buttons), unknown Draft id ("Draft not found."), the two `FAILED` wordings, and "Load more" paging. Plus one check that loading `/app/` under the real security headers produces no CSP violation (the global stylesheet must not be inline).

## Answer

Resolved in a grilling session with the repository owner on 2026-10-20. The test mechanics from [11](11-cloudflare-app-structure.md) stand (Wrangler's `createTestHarness`, `/__test/queue` and `/__test/dlq`, one real Miniflare delivery test, a `node:http` Resend stub, Docker Playwright against `wrangler dev`), as do the scenarios collected in the Comments above. This ticket settles how races are forced, how the stub behaves, isolation, time, and what each level covers.

### Levels

| Level                    | Tool                                                                                       | Covers                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Integration (priority 1) | Vitest + `createTestHarness`, `apps/cloudflare-worker/test/` and `libs/email-drafts/test/` | Every API, auth, MCP and Send-pipeline guarantee, including all races                   |
| e2e (priority 2)         | Playwright in cup's Docker image against `wrangler dev`                                    | The review flow from [12](12-review-ui.md)'s comment, end to end through the real Queue |
| CLI process              | Vitest, spawning the real `draft-approval` process against a `node:http` API stub          | Argument parsing, output, exit codes, token handling                                    |
| Unit (priority 3)        | Vitest                                                                                     | Pure functions only (see below)                                                         |
| Live contract (opt-in)   | Vitest, `pnpm test:resend-live`                                                            | Resend's idempotency behavior, against the real API                                     |

### Isolation: a fresh harness per test

- Every integration test (including the `libs/email-drafts` suite) gets its own harness through a `useWorker()` fixture: `createTestHarness` → `listen()` → apply the D1 migrations → set `RESEND_BASE_URL` to that test's own stub instance via `harness.update()` → `close()` in `afterEach`.
- A new harness starts with empty D1, R2 and Queue storage, so no test sees another's Drafts, bodies or in-flight messages, table-wide queries (lists, paging, both reconciler jobs) are deterministic, and tests in one file may run concurrently. No reset code.
- Measured with cup's Wrangler 4.144 on a toy Worker with D1, R2 and a Queue: `listen()` about 110 ms (375 ms for the first harness in a process), each migration statement about 27 ms over the binding proxy, `close()` about 3 ms. Applying the real migrations inside workerd rather than statement by statement over the proxy keeps setup well under a second per test.
- Tests reach the bindings through `worker.getEnv()` (as cup does): to backdate rows, to wrap `DB` in the gated D1 and to inspect state. There is no `/__test/d1` route; `/__test/queue` and `/__test/dlq` remain the only test-only routes.

### Forcing races

- Local D1 is one SQLite database behind one object: each statement or `batch()` runs atomically, and the statements of concurrent requests interleave one after another. Concurrent `fetch` calls alone leave the interesting order (both read, then both write) to luck.
- **Deterministic interleaving (the `libs/email-drafts` suite):** a **gated D1** test double wraps the real `DB` binding and holds a chosen statement (for example the Approval's `batch()`) until the test releases it. A test can then run "A reads, B commits, A writes" every time. No hooks in production code; the only requirement is that `libs/email-drafts` use cases take the database as a parameter (they already receive it via `drizzleForSession`).
- **Wired-up smoke (integration):** `Promise.all` of 10 concurrent HTTP requests through `worker.fetch` asserts the invariants: exactly one 200, all others the right 409, one Queue message, one email in the stub's ledger.
- **Consumer overlap:** the stub can hold a request open, so two concurrent `/__test/queue` deliveries of the same message deterministically overlap at Resend.

### Race catalogue

Each race names its winner and the loser's outcome; both the gated and the concurrent variant run where applicable.

| Race                                         | Outcome                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| approve ‖ approve, approve ‖ reject          | One verdict; the loser gets `REVISION_ALREADY_DECIDED` with `existingVerdict`                                           |
| approve ‖ revise, reject ‖ revise            | First commit wins; the loser gets `DRAFT_APPROVED` (revise lost to an Approval) or `REVISION_SUPERSEDED` (verdict lost) |
| revise ‖ revise on the same `baseRevisionId` | One new Revision; the other gets `REVISION_SUPERSEDED`                                                                  |
| submit ‖ revise, submit ‖ submit             | `REVISION_SUPERSEDED` / `REVISION_ALREADY_SUBMITTED`                                                                    |
| Same Queue message delivered twice at once   | One `SENT`, one email in the ledger; the other attempt gets `409 concurrent_idempotent_requests` and is retried         |
| Send reconciler re-enqueue ‖ consumer        | One email in the ledger                                                                                                 |
| Late `SENT` ‖ `FAILED` (deadline or DLQ)     | `SENT` wins                                                                                                             |

- **No partial writes:** every losing verdict or revise leaves the Draft and Revision rows unchanged, and the test asserts it. A D1 `batch()` does not abort when an `UPDATE` matches 0 rows, so each later statement of the Approval batch (`approvedRevisionId`, `QUEUED`, the outbox columns) and of the revise batch (Revision insert, latest-pointer update) must carry its own guard. This makes explicit what [07](07-exactly-once-sending.md)'s "conditional `batch()`" requires.

### Resend stub: a faithful idempotency model

- By default the stub models Resend's idempotency ([01](01-resend-send-semantics.md)): a ledger keyed by `Idempotency-Key`; the same key and body returns the original email id; the same key with a different body returns `409 invalid_idempotent_request`; the same key while the first request is still in flight returns `409 concurrent_idempotent_requests`.
- Per-test overrides script 429 with `Retry-After`, 5xx, a hang past the 10 s timeout, 4xx, or hold a request open (above).
- "Exactly once" is one assertion everywhere: **the ledger holds exactly one email per approved Draft**, with exactly the frozen `outgoingEmail` (so every retry provably sends the identical body).

### Time

- Code reads `Date.now()`; there is no clock abstraction. Tests backdate stored timestamps (`approved_at`, `deadline`, `enqueued_at`) by writing through `worker.getEnv().DB`, then call the consumer route or `worker.scheduled()`. This covers the 23 h deadline, the `deadline + 1 h` backstop and the reconciler's "approved more than 1 min ago".
- Backoff values are checked in unit tests; the integration test reads the `delaySeconds` the consumer route reports.
- Pacing (a batch of 8 starts together, the invocation lasts at least 1.0 s) is measured for real in one test of about 1 s.

### API, auth and MCP (integration)

- The scenarios in the Comments above (every 409 code, `baseRevisionId`, limits and 413, cursor paging, the OpenAPI snapshot, `X-Read-Bookmark`, `REVIEWER_ONLY` and the route-table test, local-token refusal, `/app` headers and SPA fallback).
- `/mcp` is driven with the official MCP SDK client over Streamable HTTP into `worker.fetch`: `tools/list` returns exactly the six tools (no verdict tool); one happy path per tool; a 409 surfaces as a tool error carrying its code; `revise_draft` without `baseRevisionId` is refused by its schema; the Reviewer token gets 403 `AGENT_ONLY`. Because MCP calls the API in-process, this also covers that wiring.

### CLI process test

- cup's pattern: spawn the real CLI against a `node:http` stub of the API (API behavior is already proven at integration level).
- Cases: `--help` on the root and every command, with no approve or reject anywhere and the OpenAPI URL linked; `--json` output parses; `RESEND_CHALLENGE_TOKEN` is sent, and without it the CLI fails naming the variable (later changed: the Agent token became a Worker secret too; the CLI first fell back to a committed Agent token); the token never appears in stdout or stderr; a 409 prints its code and exits non-zero; the built-in production URL equals `PUBLIC_BASE_URL` (a constant check, no network).

### e2e

- Isolation as in cup: each test starts its own `wrangler dev` with its own OS-assigned port and `--persist-to` temp directory, so empty states and "Load more" are deterministic.
- The Send runs through **real Miniflare Queue delivery** under `wrangler dev`, with `max_batch_timeout: 1` in the e2e Wrangler config, so "Sending…" → "Sent" appears within a poll or two. e2e is the one place the whole pipeline runs unaided.
- Each test seeds Drafts and plays the Agent's moves (for example the revise that causes `REVISION_SUPERSEDED`) through the typed client with the local Agent token. The Resend stub runs in the Playwright fixture, reachable from `wrangler dev`.
- Coverage is the list in [12](12-review-ui.md)'s comment above.
- **Screenshot baselines:** five, desktop only, exact pixel match in Docker: token screen, Pending list, Draft page (pending), Draft page after an Approval ("Sent"), inline `REVISION_SUPERSEDED` error. No component gallery.
- Locators are role-based (`getByRole` with accessible names), as in cup. No axe or other automated accessibility scan ([08](08-reviewer-surface.md) set no WCAG level).

### Unit tests

Pure functions only, no coverage threshold:

- Resend response classification ([07](07-exactly-once-sending.md)'s table: permanent vs. retryable for every status and 409 name);
- backoff (1 s start, doubling, 1 h cap, jitter bound, `Retry-After` wins, clamped to the deadline);
- deadline arithmetic;
- prefixed UUIDv7 ids;
- constant-time token-to-role resolution;
- Review UI label mapping (sending status and the two `FAILED` wordings).

Zod limits are tested through HTTP at integration level, not as unit tests.

### Live Resend contract test (opt-in)

- `pnpm test:resend-live`, not part of `validate`, needs a real `RESEND_API_KEY`, sends to `delivered@resend.dev`: the same key and body twice returns the same email id; the same key with a different body returns `409 invalid_idempotent_request`; two concurrent requests with the same key give one success and one `409 concurrent_idempotent_requests` (or the same id).
- It checks the one assumption the exactly-once guarantee rests on that no local test can: that the stub's idempotency model matches Resend.

### Flakiness and where tests run

- No retries anywhere (Vitest `retry: 0`, Playwright `retries: 0`). An intermittent failure is a bug in the test or the code. Deterministic race tests and waits on visible state (never fixed sleeps) keep this workable.
- Tests run locally only: `pnpm validate:fast` (format, lint, build, unit and integration tests, CLI process test) and `pnpm validate:extended` (e2e, needs Docker). No CI workflow and no Git hooks.

### For the spec

- Demo simplifications: extends 11's "single production environment, manual deploys" entry: tests run only locally through `pnpm validate`, with no CI and no Git hooks. _Real deployment:_ CI runs unit, integration and e2e tests on every change and gates deploys on them, plus a scheduled run of the live Resend contract test.
- Refines [07](07-exactly-once-sending.md) and [06](06-approval-binding.md): every statement in the Approval and revise batches carries its own guard, since a 0-row `UPDATE` does not abort a D1 `batch()`.
- Refines [11](11-cloudflare-app-structure.md): a fresh harness per test (not per file) with migrations applied per test; no `/__test/d1` route; the e2e Wrangler config sets `max_batch_timeout: 1`.
