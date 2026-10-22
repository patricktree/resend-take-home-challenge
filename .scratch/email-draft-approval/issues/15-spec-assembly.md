# Spec assembly

Type: grilling
Status: resolved
Blocked by: 14

## Question

How is the final, build-ready spec assembled from the resolved tickets? Settle the layout of `.scratch/email-draft-approval/spec.md` (the tracker's spec location): which sections, in which order, at which level of detail; where each ticket's decisions land and how the "Revises"/"Refines" notes between tickets are folded in, so the spec states only the final decision; how the mandatory "Demo simplifications" and "Future increments" sections and the "Known limitations" are laid out; whether the spec links back to tickets and `research/*.md` or stands alone; and how glossary terms are used and linked. Resolving this ticket means writing `spec.md` and confirming with the repository owner that nothing is left to decide before implementation starts.

## Comments

- Graduated from the map's "Not yet specified" after [13](13-testing-strategy.md) resolved; this is the map's last ticket.
- Inputs: every ticket's `## Answer` (01–14) and its "For the spec" subsection, the map's Notes (standing decisions, Demo simplifications, Future increments, Out of scope), [GLOSSARY.md](../../../GLOSSARY.md) and `research/*.md`.
- Later tickets revise earlier ones, among them: 09 revises 05 (repeated Submission is 409 `REVISION_ALREADY_SUBMITTED`); 07 refines 06 (`from` resolved at Approval time); 11 revises 10 (the local flag also needs a local host; 11 first made `AGENT_TOKEN` a committed var, which was later reverted), 09 (`reviewUrl` under `/app`) and 07 (no separate consumer Worker); 13 refines 06/07 (every statement in the Approval and revise batches carries its own guard) and 11 (a fresh harness per test). The spec must state only the final decision.
- The input spec is [spec-input.md](../spec-input.md).
- From [14](14-observability.md): the spec gets **no Observability section**. Observability appears only as the "No observability or alerting" Demo simplifications entry (which replaces 07's "no alerting" entry), plus one line in the Send pipeline that error paths `console.error` the root cause. Fold in 14's revision of 07: attempt count, last error and next attempt time are not recorded in v1.

## Answer

Resolved in a grilling session with the repository owner on 2026-10-20. The spec is [spec.md](../spec.md); the repository owner confirmed nothing is left to decide before implementation.

### Layout

- The spec stands alone and is written for the implementer (anyone else can read it too). The body never links to tickets or says "revises NN"; it states only the final rule. A closing "Sources" section links the map, the tickets and `research/*.md`, and says the spec wins where they differ.
- Sections, in order: Overview, Requirements coverage, Domain model, Architecture, Data model, HTTP API, Authentication and authorization, Approval binding and concurrency, Send pipeline, Agent interfaces, Review UI, Infrastructure/configuration/local development, Testing, Demo simplifications, Known limitations, Future increments, Out of scope, Sources.
- Ready-to-build detail: exact routes, codes, field names, enum values, config keys and timings, plus a column-level D1 schema derived from the decisions. Code appears only as JSON shapes; rationale is one sentence and only where a rule would surprise a reader; there is no catalogue of rejected alternatives.
- Glossary: linked once in the Overview, terms used capitalised and never redefined; implementation terms (Draft summary, Send reconciler, outbox columns, read bookmark) are defined in the spec and stay out of `GLOSSARY.md`. No glossary changes.
- A Requirements coverage table maps every line of [spec-input.md](../spec-input.md) to its mechanism and section.
- Two Mermaid diagrams (architecture, Approval to Send); state machines as tables.
- Demo simplifications: bold title, _Demo:_ and _Real deployment:_, grouped under Identity and access / Operations and deployment / Data. Known limitations: stale CLI/MCP reads, non-idempotent create, Resend outages beyond 23 h end in `OUTCOME_UNKNOWN`, replica lag for readers without the writer's bookmark. Future increments: bulleted, HTML body first.
- No implementation plan or task breakdown in the spec.

### Decisions made while assembling

- 14 wins over 10 on logging: nothing logs per request; tokens never appear in any log, error message or CLI output.
- An unhandled exception returns 500 `INTERNAL_ERROR` (generic message, `requestId`); every response carries `X-Request-Id`.
- `max_batch_timeout: 1` for the Send Queue in production as well as e2e.
- `updatedAt` is renamed `lastActionAt` (column `last_action_at`; `orderBy=createdAt|lastActionAt`, default `lastActionAt` desc). Only create, revise, submit and verdicts set it; Send outcomes do not, so the Decided list stays in decision order.
- Resend statuses not in 07's table: any other 4xx (including a 409 with an unknown name) is final `REJECTED_BY_RESEND`; any other status, or a 2xx without an `id`, is retryable.
- No caching anywhere: no `Cache-Control` set by the Worker or API and no CDN cache rule (revises 11's immutable assets / `no-cache` `index.html`).
- Confirmed derived details: timestamps as integer milliseconds; no foreign key on `drafts.latest_revision_id`; single-row `CHECK`s (`NOT_SENT` exactly when `approved_revision_id` is null, `approved_revision_id = latest_revision_id`); `lastVerdict` computed from the highest decided `revision_number`; guarded batches where every statement shares one predicate and the statement that falsifies it runs last, with a primary read to classify a no-op; `DRAFT_APPROVED` before `REVISION_SUPERSEDED` on revise, and any non-latest `baseRevisionId` gets `REVISION_SUPERSEDED`; cursors encode ordering value plus `id` and are rejected with other filters; backoff exponent from `message.attempts`; the reconciler rebuilds messages from the outbox columns; the tag is `[{ name: "draft_id", value }]`; the CLI runs from a checkout (`pnpm resend-challenge …`), not npm.
