# API resources and operations

Type: grilling
Status: resolved
Blocked by: 02, 05

## Question

What is the HTTP API surface: resources, operations, request and response shapes, error model, and how they are described in OpenAPI? How does each operation map to MCP tools and CLI commands, and how does an Agent discover the available tools? Which operations exist only for the Reviewer and never appear in the Agent-facing client, MCP server or CLI?

## Comments

- From [05](05-draft-lifecycle.md): Agent operations are create, get, revise and submit (naming a Revision id); no send and no discard operation. Draft responses expose review status, sending status and the latest verdict with reason; per-Revision review status is visible too. Submitting a pending Revision is an idempotent no-op; a rejected or superseded one is an error. Enum values are upper snake case. Whether a "revise and submit" shortcut exists is this ticket's call.
- From [06](06-approval-binding.md): verdict endpoints name Draft id + Revision id (e.g. `POST /drafts/{draftId}/revisions/{revisionId}/approval`, final paths are this ticket's). Error codes: `REVISION_SUPERSEDED` (409, code+message only), `REVISION_ALREADY_DECIDED` (409, with `existingVerdict`; also for a repeated identical verdict), `REVISION_NOT_SUBMITTED` (409), 404 for unknown Draft/Revision or Revision of another Draft, and Agent-side `DRAFT_APPROVED` (409) when revising an approved Draft. This ticket defines the envelope and OpenAPI description.
- From [07](07-exactly-once-sending.md): every mutating response returns the D1 Sessions bookmark in a header and every read accepts it (header name is this ticket's); the typed client keeps the latest bookmark and sends it automatically; the CLI and MCP server do not persist it (accepted stale reads). Draft responses expose sending status, the Resend email ID when `SENT`, and `failureReason` when `FAILED` (`REJECTED_BY_RESEND` with Resend's error name and message, or `OUTCOME_UNKNOWN`); attempt details are not exposed. An Approval returns 200 with `QUEUED` even if the inline enqueue failed. Revision bodies are stored in R2, so the maximum body size is this ticket's call and no longer bound by the 128 KB Queue message limit.
- From [08](08-reviewer-surface.md): Draft responses (and so the Submission response) carry a `reviewUrl` to the Draft's page in the Review UI, built from one configured public base URL (field name is this ticket's). The Review UI needs Reviewer reads for the Pending list, the Decided list (latest Revision has a verdict; review and sending status; newest first) and one Draft by id; unsubmitted Drafts are never in Reviewer lists. The CLI (generated from the endpoints or hand-written) is an Agent tool and never contains verdict operations (approve, reject). The repository owner expects only the verdict operations to be excluded from Agent-facing surfaces, since listing Drafts or reading one Draft may be useful to Agents too; decide here which reads Agents get.
- Amended by [10](10-agent-reviewer-separation.md): `/mcp` answers the Reviewer token with 403 `AGENT_ONLY`; both bearer schemes are `http bearer` (`agentAuth`, `reviewerAuth`).
- Revised by [15](15-spec-assembly.md): `updatedAt` is renamed `lastActionAt` (`orderBy=createdAt|lastActionAt`, default `lastActionAt` desc) and is set only by create, revise, submit and verdicts, never by a Send outcome; an unhandled error returns 500 `INTERNAL_ERROR`, and every response carries `X-Request-Id`. [spec.md](../spec.md) is authoritative.

## Answer

Resolved in a grilling session with the repository owner on 2026-10-20.

### One API, one contract

- A single HTTP API, one `@hono/zod-openapi` contract package and one typed client (Hono RPC `hc` wrapped in a class, as in cup), used by the Review UI, the MCP server and the CLI. No separate Agent and Reviewer APIs.
- Every route except the two verdict routes accepts both Agent credentials and the Reviewer credential. Approval and Rejection are Reviewer-only: they carry a separate OpenAPI security scheme (`reviewerAuth`), say "Reviewer only" in their description, and answer an Agent credential with 403 `REVIEWER_ONLY`. How credentials are told apart is [10](10-agent-reviewer-separation.md)'s.
- The MCP server and the CLI never expose the verdict routes. Both are hand-written on the typed client, not generated.
- The version segment is part of each route's own path (`/api/v1/drafts…`), declared per `createRoute`, not a router mount prefix, so a single endpoint can get a `v2` next to the `v1` routes.

### OpenAPI is the published contract

- The OpenAPI 3.1 document, generated code-first from the routes, is the published contract Agents discover. It is served without authentication at `GET /api/openapi.json` and covers every route, the verdict routes included (marked Reviewer only).
- A snapshot test checks the generated document against a committed copy, so contract changes show up in review.
- Discovery: MCP `tools/list`, `server/discover` and the server `instructions`; CLI `--help` on every command; the OpenAPI URL, linked from both the MCP instructions and the CLI root help. No `llms.txt`.

### Operations

| Operation    | Route                                                                            | Who      | Success                               |
| ------------ | -------------------------------------------------------------------------------- | -------- | ------------------------------------- |
| Create       | `POST /api/v1/drafts`                                                            | any      | 201, Draft summary                    |
| List         | `GET /api/v1/drafts`                                                             | any      | 200, `{ items, nextCursor }`          |
| Get          | `GET /api/v1/drafts/{draftId}`                                                   | any      | 200, Draft with body                  |
| Revise       | `POST /api/v1/drafts/{draftId}/revisions`                                        | any      | 201, Draft summary                    |
| Submit       | `POST /api/v1/drafts/{draftId}/revisions/{revisionId}/submission`                | any      | 200, Draft summary                    |
| Get Revision | `GET /api/v1/drafts/{draftId}/revisions/{revisionId}`                            | any      | 200, Revision with body               |
| Approve      | `POST /api/v1/drafts/{draftId}/revisions/{revisionId}/approval` (empty body)     | Reviewer | 200, Draft summary (sending `QUEUED`) |
| Reject       | `POST /api/v1/drafts/{draftId}/revisions/{revisionId}/rejection` (`{ reason? }`) | Reviewer | 200, Draft summary                    |

- No send, discard, revise-and-submit shortcut or Revision history list. No idempotency for create (a retried create may make a second Draft; accepted, not listed as a simplification).
- Revise requires `baseRevisionId`, the Revision the change builds on; if it is not the latest Revision, 409 `REVISION_SUPERSEDED`. This guards against lost updates and duplicate Revisions from retries.
- Drafts are not scoped per Agent: every Agent credential sees and can revise every Draft (Demo simplification; a real deployment records the creating Agent and scopes to it). Holds while [10](10-agent-reviewer-separation.md) keeps a shared Agent credential.
- **Revises [05](05-draft-lifecycle.md):** submitting a Revision that is already `PENDING` is no longer an idempotent no-op but 409 `REVISION_ALREADY_SUBMITTED`; a client retrying after a timeout learns from it that the first Submission went through. MCP and CLI report it as an error with that code.
- Submission errors: `DRAFT_APPROVED` (takes precedence when submitting the approved Revision itself), `REVISION_SUPERSEDED`, `REVISION_ALREADY_DECIDED` (with `existingVerdict`), `REVISION_ALREADY_SUBMITTED`.
- Verdict errors are [06](06-approval-binding.md)'s: `REVISION_SUPERSEDED`, `REVISION_ALREADY_DECIDED` (with `existingVerdict`), `REVISION_NOT_SUBMITTED`; Revise on an approved Draft gives `DRAFT_APPROVED`.

### Shapes

- IDs are prefixed UUIDv7 (`drf_…`, `rev_…`): time-sortable, and the prefix keeps an Agent from mixing up the two ids every Submission names. Each Revision also has a 1-based `revisionNumber`. Timestamps are ISO 8601 UTC. Fields without a value are omitted, never `null`.
- Draft data request: `{ to: string[], subject: string, body: { plainText: string } }` (Revise adds `baseRevisionId`). `body` is an object so a later `html` becomes a sibling field (`{ plainText?, html? }`, at least one) without a shape change.
- Draft:

  ```json
  {
    "id": "drf_…",
    "createdAt": "…",
    "updatedAt": "…",
    "reviewStatus": "PENDING",
    "latestRevision": {
      "id": "rev_…",
      "revisionNumber": 3,
      "createdAt": "…",
      "to": ["…"],
      "subject": "…",
      "body": { "plainText": "…" },
      "reviewStatus": "PENDING",
      "submittedAt": "…"
    },
    "lastVerdict": {
      "revisionId": "rev_…",
      "revisionNumber": 2,
      "verdict": "REJECTED",
      "reason": "…",
      "decidedAt": "…"
    },
    "sending": { "status": "NOT_SENT" },
    "reviewUrl": "https://…/drafts/drf_…"
  }
  ```

  - `reviewStatus` is the latest Revision's (never `SUPERSEDED`). The Revision object also carries `decidedAt` and `rejectionReason` when present; the Get Revision route returns the same object.
  - `lastVerdict` is the newest verdict on any of the Draft's Revisions, so after a Rejection and a revise the Agent still sees the reason.
  - `sending` is `{ status, emailId? (when SENT), failure? (when FAILED) }`, with `failure = { reason: REJECTED_BY_RESEND | OUTCOME_UNKNOWN, resendErrorName?, resendErrorMessage? }`. Attempt details stay in logs ([07](07-exactly-once-sending.md)).
  - `reviewUrl` points to the Draft's page in the Review UI, built from one configured public base URL.

- **Draft summary** = the Draft without `latestRevision.body`. Lists and every mutation return it, so neither reads R2; only the two `GET`s by id return a body.

### Lists

- `GET /api/v1/drafts` filters with `reviewStatus` (repeatable; `UNSUBMITTED|PENDING|APPROVED|REJECTED`) and `sendingStatus` (repeatable), orders with `orderBy=createdAt|updatedAt` and `order=asc|desc` (default `updatedAt`, `desc`), and pages with an opaque `cursor` and `limit` (default 50, max 100).
- The Review UI's Pending list is `reviewStatus=PENDING&order=asc` (a Pending Draft's last change is its Submission, so this is longest-waiting first); its Decided list is `reviewStatus=APPROVED&reviewStatus=REJECTED`. "Pending" and "Decided" are UI and glossary terms, not API parameters.
- Unsubmitted Drafts are readable through the API by the Reviewer credential; keeping them out of the Reviewer's view is the Review UI's job (it only queries those two lists, and a Draft opened by URL before submission shows "Not submitted for review yet" without verdict buttons). No 404 special case.

### Limits and request format

- `to`: 1–50 addresses (Resend's maximum per email), each a valid address, no duplicates.
- `subject`: 1–998 characters, no line breaks. Justification: RFC 5322 §2.1.1 caps a header line at 998 characters; longer subjects need folding, which some clients and filters handle badly. Resend documents no subject limit of its own.
- `body.plainText`: 1 character to 100 KB (UTF-8 bytes). Justification: no external limit binds (Resend caps a whole email at 40 MB), so this is our own: the Reviewer must read the whole body before approving, and Gmail clips messages over about 102 KB.
- Rejection `reason`: optional, 1–2000 characters, trimmed; an empty string counts as absent.
- Request body limit 128 KB → 413 `PAYLOAD_TOO_LARGE`; other violations → 400 `INVALID_REQUEST`.
- Requests are JSON, buffered and Zod-validated, then the body object is written to R2 in one `put` as JSON at `revisions/<revisionId>/body`. Streaming a multipart part into R2 was considered and rejected: it is possible without changing Hono (read `c.req.raw.body` with a streaming multipart parser), but it bypasses `@hono/zod-openapi` validation, R2 needs a known length (the client would have to declare part lengths for a `FixedLengthStream`), and size/UTF-8 checks mid-stream need abort handling, all to save at most 100 KB of buffering.

### Error model

- Envelope (cup's): `{ "error": { "code", "message", "requestId", …extras } }`, codes in upper snake case, extras inside `error` (e.g. `existingVerdict`). Every route lists each status code in OpenAPI with the shared schema; each 409 names its possible codes in the description.

| HTTP | Codes                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST` (with `issues: [{ path, message }]` from Zod)                                                                                   |
| 401  | `UNAUTHENTICATED`                                                                                                                                 |
| 403  | `REVIEWER_ONLY`                                                                                                                                   |
| 404  | `DRAFT_NOT_FOUND`, `REVISION_NOT_FOUND` (also a Revision of another Draft)                                                                        |
| 409  | `REVISION_SUPERSEDED`, `REVISION_ALREADY_DECIDED` (+ `existingVerdict`), `REVISION_NOT_SUBMITTED`, `REVISION_ALREADY_SUBMITTED`, `DRAFT_APPROVED` |
| 413  | `PAYLOAD_TOO_LARGE`                                                                                                                               |

### Read bookmark

- Header `X-Read-Bookmark` on requests and responses, documented on every operation: writes return it, reads accept and return it. The typed client keeps the latest and sends it ([07](07-exactly-once-sending.md)); CLI and MCP do not persist it.

### MCP server

- Six tools, hand-written on the typed client: `create_draft`, `get_draft`, `list_drafts`, `revise_draft` (needs `baseRevisionId`), `submit_draft` (needs `draftId` and `revisionId`), `get_revision`.
- Input schemas reuse the contract's Zod schemas; every tool declares an `outputSchema` and returns `structuredContent`; `readOnlyHint` on reads. API errors become `isError` results carrying code and message.
- Server `instructions` describe the lifecycle (create → submit → a human reviews at `reviewUrl` → poll `get_draft`), state that Agents cannot approve or send, and link the OpenAPI document. No revise-and-submit tool.

### CLI

- `draft-approval`, built with `commander` + `@commander-js/extra-typings` as in cup's `apps/operator`: `drafts create --to … [--to …] --subject … (--body … | --body-file <path|->)`, `drafts get <draftId>`, `drafts list [--review-status …] [--sending-status …] [--order-by …] [--order …] [--limit …] [--cursor …]`, `drafts revise <draftId> --base-revision <revisionId> …`, `drafts submit <draftId> <revisionId>`, `drafts revision <draftId> <revisionId>`.
- cup's conventions: `--api-url` / env, token from env, human-readable output by default, `--json` for one JSON value on stdout, errors as `{ error: { code, message } }` on stderr with exit 1, inputs validated with the contract's Zod schemas.

### For the spec

- Demo simplifications: Drafts are not scoped per Agent; every Agent credential sees and revises every Draft (a real deployment records the creating Agent and scopes reads and writes to it).
- Future increments: large bodies and attachments through a dedicated upload endpoint (or presigned R2 URLs), not by streaming the Draft request.
