# Storage and app structure on Cloudflare

Type: grilling
Status: resolved
Blocked by: 02, 03, 07, 09

## Question

How is the system laid out on Cloudflare? Settle: D1 vs Durable Objects (or both) for Drafts, Revisions, verdicts and the send record; one Worker vs several (API, Reviewer UI, MCP server, send processing); how the Reviewer UI is built and served; how secrets (Resend API key, credentials) are configured; local development and test setup on Cloudflare's local runtime.

## Comments

- From [05](05-draft-lifecycle.md): Revision rows hold immutable Draft data plus a mutable review status and rejection reason; the Draft row holds the latest Revision id and sending status. Transitions are conditional `UPDATE`s; with SQL storage, `CHECK` constraints enforce the allowed status combinations (e.g. sending status leaves `NOT_SENT` only when the latest Revision is `APPROVED`; rejection reason only on `REJECTED`).
- From [07](07-exactly-once-sending.md) (option C of [send-topology-options](../research/send-topology-options.md)): D1 is the single source of truth (no Durable Objects for Draft state); the Draft row carries the outbox columns (`approved_revision_id`, frozen `outgoing_email`, `idempotency_key`, `deadline`, `enqueued_at`, `email_id`, `failure_reason`) with partial indexes on `approved_at` where `QUEUED` and `enqueued_at IS NULL`, and on `deadline` where `QUEUED`. An R2 bucket holds Revision bodies at `revisions/<revisionId>/body`. One Queue with consumer settings `max_concurrency: 1`, `max_batch_size: 8`, `max_retries: 100`, a DLQ with its own consumer, retention at least the default 4 days. A cron trigger every minute runs the Send reconciler. List reads use D1 read replication through the Sessions API. Only the consumer needs `RESEND_API_KEY`; whether it is a separate Worker is this ticket's call. Local tests need a Resend stub (`fetch` mock or `baseUrl`) and must cover Queue redelivery, whose Miniflare fidelity is unknown.
- From [09](09-api-surface.md): one Hono app with one `@hono/zod-openapi` contract package and one typed client; routes carry the version per route (`/api/v1/drafts…`), the OpenAPI document is served at `GET /api/openapi.json`. The Revision body is stored as one JSON object (`{ plainText }`, later `{ plainText?, html? }`) at `revisions/<revisionId>/body`, written with a single R2 `put` after Zod validation of a buffered JSON request (128 KB request limit, 100 KB body). Lists and every mutation return a body-less Draft summary, so only `GET` by id reads R2. IDs are prefixed UUIDv7 (`drf_…`, `rev_…`); each Revision has a per-Draft `revisionNumber`; lists filter on `review_status`/`sending_status` and order by `created_at`/`updated_at` with cursor paging, so the indexes should cover those. Where the MCP server (`/mcp`) runs is this ticket's call.
- From [10](10-agent-reviewer-separation.md): the Review UI SPA and the API must be served from the **same origin**. The API sends no CORS headers, and the SPA's CSP is `connect-src 'self'`. Credentials are two Worker secrets, `AGENT_TOKEN` and `REVIEWER_TOKEN` (prefixed `agent_…` / `reviewer_…`, one value each, rotated by redeploying). This ticket decides how they are generated, set (`wrangler secret put`?) and handed to evaluators. Fixed `LOCAL_AGENT_TOKEN` / `LOCAL_REVIEWER_TOKEN` are exported from the routes package and accepted only under a local-environment flag; this ticket defines that flag. The SPA responses carry `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, so serving static assets must allow setting headers (for example a `_headers` file or Worker middleware). `/mcp` lives in the same Worker or at least behind the same auth middleware, accepts only the Agent token (403 `AGENT_ONLY` for the Reviewer token) and calls the API with the caller's token. The CLI's built-in production API URL is a constant that must match the deployed URL.
- Revised by [15](15-spec-assembly.md): no caching anywhere (no `Cache-Control` from the Worker, no immutable assets, no `no-cache` on `index.html`); the Send Queue consumer sets `max_batch_timeout: 1`. [spec.md](../spec.md) is authoritative.

## Answer

Resolved by grilling with Patrick on 2026-10-20. Earlier tickets fixed storage (07: D1 as the single source of truth, Revision bodies in R2, no Durable Objects, one Queue + DLQ, a Send reconciler cron, D1 read replication via the Sessions API), the API (09) and same-origin serving plus the token model (10). This ticket settles the physical layout around them.

### One Worker

- A single Worker exports `fetch`, `queue` and `scheduled`, as in cup:
  - `fetch` serves `/api/*`, `/mcp` and `/app*`;
  - `queue` handles both the send Queue and the DLQ, dispatching on `batch.queue`;
  - `scheduled` runs the Send reconciler (cron every minute).
- No separate sender Worker. `RESEND_API_KEY` is a secret on this Worker; only the Send code in `libs/drafts` reads it. A second Worker would only isolate the key from our own code, at the cost of doubled config, deploys and test wiring.
- `compatibility_flags: ["nodejs_compat"]`, `workers_dev: false`, `preview_urls: false`. Deploys run manually: `wrangler deploy` (after `terraform apply` and `wrangler d1 migrations apply --remote`).

### Routing in `fetch`

`assets.run_worker_first: true`, `html_handling: "none"`, `not_found_handling: "none"` (cup's setup): every request goes through Hono first.

| Path             | Handling                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `/api/*`         | API routes; an unknown `/api/...` path → JSON 404 `NOT_FOUND`                           |
| `/mcp`           | MCP server ([10](10-agent-reviewer-separation.md): Agent token only)                    |
| `/app`, `/app/*` | `env.ASSETS`; no matching file → `/app/index.html` with 200, so client routes deep-link |
| `/`              | 302 to `/app/`                                                                          |
| anything else    | JSON 404 `NOT_FOUND`                                                                    |

- The Review UI lives under `/app`. Vite builds it with `base: "/app/"`, TanStack Router uses `basepath: "/app"`, and the build output lands in an `app/` subfolder of the Worker's assets, so a request path maps to the asset path without rewriting.
- One Hono middleware sets 10's CSP, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` on every `/app` response. Hashed files under `/app/assets/` are cached as immutable; `index.html` gets `no-cache`. An integration test asserts these headers. A `_headers` file plus the platform's SPA fallback was rejected because headers would then live in a second place that integration tests do not exercise the same way.
- `reviewUrl` ([09](09-api-surface.md)) is `${PUBLIC_BASE_URL}/app/drafts/{draftId}`.

### MCP calls the API in-process

- `/mcp` builds the typed client (`hc`) with a custom `fetch`: `(request) => app.fetch(request, env, ctx)`. Every tool call runs through the same Hono app, so it passes the same auth middleware, `REVIEWER_ONLY` guard and validation. MCP can never bypass the API's checks. This also avoids a Worker fetching its own public hostname.

### Data access

- Drizzle on D1. The schema (including `CHECK`s via `check()` and partial indexes via `index().where()`) is a Drizzle schema. `drizzle-kit generate` emits SQL files into the D1 migrations folder. They are committed and applied with `wrangler d1 migrations apply` (remote before deploy, local before `pnpm dev`), and with `applyD1Migrations()` in tests. Queries go through Drizzle, with `db.batch()` for the Approval and a raw `sql` fragment where a conditional `UPDATE … WHERE` needs it.
- Every request runs on a D1 session: writes start it with `"first-primary"`, reads with the incoming `X-Read-Bookmark` ([07](07-exactly-once-sending.md), 09). Every response returns `session.getBookmark()`.
- Drizzle 0.45 types its D1 driver as `D1Database` only, while `withSession()` returns a `D1DatabaseSession` (which has the `prepare` and `batch` Drizzle uses). One helper, `drizzleForSession(env.DB, bookmark)`, does the cast in one place, with a comment pointing at the limitation. Integration tests run reads and writes through it. Delete it once Drizzle accepts sessions.

### Packages (cup's layout, `@draft-approval/*`)

| Folder                   | Role                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cloudflare-worker` | Thin: `wrangler.jsonc`, Vite build with `@cloudflare/vite-plugin`, exports `fetch` (`api.server`), `queue` and `scheduled` (both delegate to `drafts`)                                                                                                                             |
| `apps/review-ui`         | React 19 SPA (TanStack Router + Query), served under `/app`                                                                                                                                                                                                                        |
| `apps/cli`               | `draft-approval` CLI                                                                                                                                                                                                                                                               |
| `libs/api.routes`        | `@hono/zod-openapi` contract, Zod schemas, `LOCAL_AGENT_TOKEN` / `LOCAL_REVIEWER_TOKEN`                                                                                                                                                                                            |
| `libs/api.client`        | Typed client (`hc` wrapped in a class), OpenAPI export                                                                                                                                                                                                                             |
| `libs/api.server`        | Hono app: routing, auth, error envelope, `/app` serving; calls into `drafts`                                                                                                                                                                                                       |
| `libs/drafts`            | The Draft domain: Drizzle schema and migrations, R2 body storage, use cases (create, revise, submit, approve, reject, list, get), the Queue consumer, the DLQ consumer, the Send reconciler, and an internal Resend adapter (plain `fetch` against `RESEND_BASE_URL`, as cup does) |
| `libs/mcp-server`        | Six MCP tools on the typed client                                                                                                                                                                                                                                                  |
| `qa/e2e`                 | Playwright                                                                                                                                                                                                                                                                         |
| `terraform/`             | Infrastructure                                                                                                                                                                                                                                                                     |

- Storage and the Send pipeline are one package because the outbox columns live on the Draft row: the Draft's invariants and the Send's conditional writes belong to one module, like cup's domain libraries (`accounts`, `registry`).

### Infrastructure: Terraform plus Wrangler

- Production only, no staging, on the custom domain **`resend-challenge.patricktree.me`** (route in `wrangler.jsonc`, `custom_domain: true`).
- **Terraform** (Cloudflare provider v5, Resend provider) manages: the D1 database with read replication `auto`, the R2 bucket for Revision bodies, the send Queue and the DLQ, and the Resend sending domain `resend-challenge.patricktree.me` with its verification DNS records in the Cloudflare zone. `from` is an address on that domain, for example `drafts@resend-challenge.patricktree.me`.
- Terraform state lives in an R2 bucket through the S3 backend, created once by hand as a bootstrap step. `terraform apply` runs manually before `wrangler deploy`.
- **`wrangler.jsonc`** owns what `wrangler deploy` owns: the Worker, route, cron trigger, Queue consumer settings (from 07: `max_concurrency: 1`, `max_batch_size: 8`, `max_retries: 100`, DLQ), bindings with the resource IDs from `terraform output` (committed), and vars.
- Vars: `PUBLIC_BASE_URL` (`https://resend-challenge.patricktree.me`; the CLI's built-in production URL must equal it), `RESEND_FROM`, `RESEND_BASE_URL` (default `https://api.resend.com`), `LOCAL_DEVELOPMENT` (`"false"`), `AGENT_TOKEN`.
- Secrets (`secrets.required`, so a deploy without them fails, set with `wrangler secret put`): `REVIEWER_TOKEN`, `RESEND_API_KEY` (sending-only key).

### Tokens (refines [10](10-agent-reviewer-separation.md))

- `pnpm secrets:generate` creates both tokens once (`agent_` / `reviewer_` + base64url of 32 random bytes). It writes the Agent token into `wrangler.jsonc` and pipes the Reviewer token into `wrangler secret put`, printing it once.
- **The Agent token is public and committed**: a plain var `AGENT_TOKEN` in `wrangler.jsonc` (10 had it as a Worker secret; the code reads `env.AGENT_TOKEN` either way). The README shows it. The CLI falls back to it when `DRAFT_APPROVAL_TOKEN` is unset (as it already falls back to the production URL), and the MCP setup instructions use it, so an evaluator needs no setup.
- **The Reviewer token is never committed.** It reaches evaluators out of band, in the submission message. Committing it was considered and rejected: any Agent that can read the repo could then approve (breaking the core requirement, as 10 found for the SPA bundle), and anyone could send arbitrary email through the Resend account and domain.

### Local-environment flag (defines 10's flag)

- `LOCAL_DEVELOPMENT` is `"false"` in `wrangler.jsonc`, and `"true"` only in the gitignored `.dev.vars` (copied from a committed `.dev.vars.example`) and in `wrangler.test.jsonc`.
- `LOCAL_AGENT_TOKEN` / `LOCAL_REVIEWER_TOKEN` are accepted only when `LOCAL_DEVELOPMENT === "true"` **and** the request host is `localhost`, `127.0.0.1`, `[::1]` or `host.docker.internal` (the last one for Docker Playwright). On Cloudflare the request host is the routed hostname, which a client cannot set to one of these, so a production Worker deployed with the flag misset still rejects the public fixed tokens. With the flag on, `REVIEWER_TOKEN` and `RESEND_API_KEY` may be absent.

### Local development

- `pnpm dev`: `wrangler d1 migrations apply --local`, then `vite`, which serves the Worker and the SPA under `/app` with hot reload. D1, R2 and the Queue run locally in Miniflare, so a local Approval really goes through the Queue to the consumer.
- Resend in dev is the real API with the developer's own key from `.dev.vars`. `.dev.vars.example` points to Resend's test recipients (`delivered@resend.dev`, `bounced@resend.dev`), which exercise the real API without delivering mail.
- The cron does not fire locally on its own. It is triggered with `curl` on `/cdn-cgi/handler/scheduled` (documented in the README).
- `pnpm seed` creates a handful of Drafts through the typed client with the local tokens (Pending, Rejected, and Approved to `delivered@resend.dev`), so the Review UI is not empty.

### Test setup

- **Integration tests** (priority 1) run the whole Worker in Wrangler's local test runtime (`createTestHarness`), in `apps/cloudflare-worker/test/`:
  - `wrangler.test.jsonc` declares local D1, R2 and Queues, `LOCAL_DEVELOPMENT: "true"` and `RESEND_BASE_URL` pointing at the Resend stub;
  - `test/worker.ts` re-exports the production Worker and adds test-only routes `POST /__test/queue` and `POST /__test/dlq`, which build a `MessageBatch` inside workerd, call the real `queue()` handler with the real bindings and return each message's ack / retry / `delaySeconds`. These routes are not in the production build;
  - `applyD1Migrations()` runs before each test file; requests go through `worker.fetch`, the cron through `worker.scheduled()`.
- Wrangler's local test runtime cannot dispatch a Queue batch, and real Miniflare delivery is timing-based and cannot force a duplicate. So every consumer scenario (duplicate delivery, retry with delay, DLQ) goes through the test-only routes, and exactly one test checks that a message sent by an Approval really reaches the consumer through Miniflare.
- The Resend stub is a `node:http` server on an OS-assigned port, started by Vitest and scripted per test (409/429/5xx/timeouts), as in cup's CLI test. Tests never call Resend.
- `libs/drafts` gets its own smaller suite in the same local runtime only where a use case is easier to pin down without HTTP (for example, a race between two concurrent conditional writes).
- **e2e** (priority 2): the built Worker runs under `wrangler dev` with the test vars on an OS-assigned port, and Playwright runs in cup's Docker Playwright image against it, with the Resend stub.
- Which scenarios prove the concurrency and exactly-once guarantees, and the e2e coverage of the review flow, are [13](13-testing-strategy.md)'s.

### For the spec

- Demo simplifications:
  - **Public Agent token**: the Agent token is committed to the repo and shown in the README, so anyone can create, revise and submit Drafts (and fill the Pending list). Nothing is sent without the Reviewer token, which is never committed. _Real deployment:_ per-Agent credentials issued and rotated through an authorization server (see 10's entries), never in source control.
  - **Single production environment, manual deploys**: no staging, `terraform apply` and `wrangler deploy` run by hand. _Real deployment:_ a staging environment and CI-driven deploys with migrations gated on review.
- Revises: [10](10-agent-reviewer-separation.md) (`AGENT_TOKEN` is a committed var, not a secret; the local flag also requires a local host); [09](09-api-surface.md) (`reviewUrl` is under `/app`); [07](07-exactly-once-sending.md) (the consumer is not a separate Worker).
