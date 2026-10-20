# Send topology options

Working comparison for [ticket 07](../issues/07-exactly-once-sending.md), written during the grilling on 2026-10-20.

**Decision (Patrick, 2026-10-20): option C**, D1 outbox + Queue + reconciler cron, with the [shared Send pipeline](#shared-send-pipeline-in-b-and-c). The other options stay here as the record of what was considered; B is the named path if per-Draft write locality ever matters.

Every option uses the same Resend idempotency key per Draft and the same frozen `outgoingEmail` (`from`, `to`, `subject`, plus the R2 key of the body), so none of them can send two emails for one Draft within Resend's 24 h window; they differ in everything around that.

## Body in R2 (all options)

- Each Revision's body is an R2 object at `revisions/<revisionId>/body`, written before the database commit that creates the Revision; `to` and `subject` stay in the database. A failed commit leaves an orphan object that nothing references.
- Revisions are immutable, so the object never changes and the frozen `outgoingEmail` stores only its key; every Send attempt reads the body from R2 (strongly consistent after the write) and builds the identical Resend request.
- Consequences shared by all options: Queue messages and Workflow params carry only ids and keys, the database holds metadata only, and reading a Draft for the Reviewer or the Agent adds one R2 read. The maximum body size is still to be decided (ticket 09); it no longer depends on the option.
- Two rows dropped out of the comparison because the options no longer differ there: the size limit for `outgoingEmail` (was 128 KB per Queue message for B and I) and the storage ceiling (was 10 GB per D1 database or per DO, now metadata only).

## Options

- **A) Worker + D1 + cron:** D1 holds Drafts and outbox columns; a 1-minute cron claims due Sends with a lease and calls Resend; the Approval makes one inline first attempt via `waitUntil`.
- **B) DO per Draft + Queue + D1 read model:** each Draft's DO is the source of truth and runs the [shared Send pipeline](#shared-send-pipeline-in-b-and-c) with its alarm as the Send reconciler; D1 is a versioned projection for the lists. A verdict writes the projection to the D1 primary *before* committing locally (inside `blockConcurrencyWhile`, guarded by a "projection in flight" marker plus alarm), so a failed D1 write fails the verdict and the Reviewer's next list read with the returned bookmark already reflects it; Agent writes project asynchronously.
- **C) D1 outbox + Queue + reconciler cron:** D1 is the single source of truth and runs the [shared Send pipeline](#shared-send-pipeline-in-b-and-c) with a 1-minute cron as the Send reconciler; verdict responses return the D1 bookmark for read-your-writes.
- **D) D1 + Workflow per Draft + cron reconciler:** the Approval commits to D1 and creates a Workflow instance named by the Draft id; its retried step sends and records the outcome; a cron creates missing instances and catches errored ones.
- **E) One coordinator DO:** a single DO holds every Draft, Revision and Send; its alarm loop sends.
- **F) DO per Draft, sending directly:** each Draft's DO alarm drives its own Send; D1 read model for the lists.
- **G) DO per Draft + singleton Sender DO with its own outbox:** Draft DOs hand the Send to one central DO that stores and drives every attempt; D1 read model for the lists.
- **H) Postgres via Hyperdrive:** an external Postgres holds everything; a cron Worker claims due rows with `FOR UPDATE SKIP LOCKED` and sends.
- **I) B without the reconciler alarm:** the Draft DO enqueues inline after its commit; nothing retries a failed hand-off.
- **J) D1 outbox + singleton Sender DO alarm loop:** D1 is the single source of truth; one Sender DO (no Draft state) is woken after each Approval, re-checks at least every minute, claims due rows with a D1 lease and calls Resend itself.
- **K) J + Queue:** as J, but the Sender DO only schedules (records a dispatch with an `attempt` fence and enqueues ids); a Queue consumer reads `outgoingEmail` from D1, calls Resend and writes the outcome or the next attempt time back to D1.

## Shared Send pipeline in B and C

B and C differ only in where the Draft state lives (Draft DO vs D1) and in what runs the Send reconciler (DO alarm vs cron); the Send itself works the same way.

1. **Approval commit:** one atomic step (a DO SQL step in B, a D1 `batch()` in C) records the Approval, sets sending status `QUEUED`, and freezes `idempotencyKey = draft-send/<draftId>`, `outgoingEmail` (`from` resolved from configuration now, `to`, `subject`, body key, tag `draft_id`) and `deadline = approvedAt + 23 h`.
2. **Hand-off:** right after the commit, the same request calls `queue.send({ draftId, idempotencyKey, outgoingEmail, deadline })` and then records `enqueuedAt`.
3. **Consumer (stateless, identical in B and C):** if the deadline has passed, it records `FAILED` / `OUTCOME_UNKNOWN` without calling Resend; otherwise it reads the body from R2, calls Resend with the key, and either records a final outcome (`SENT` with the email ID, or `FAILED` / `REJECTED_BY_RESEND`) or, on a retryable result (including every 429), calls `message.retry({ delaySeconds })` with delay = max(backoff, `Retry-After` if present); backoff starts at 1 s, doubles, is capped at 1 h and gets up to 1 s of jitter, clamped to the deadline (about 35 attempts within 23 h). The Queue is the only retry clock. Pacing: `max_concurrency: 1`, `max_batch_size: 8`, and each invocation starts its batch's calls together and lasts at least 1 s; a 429 that still slips through is just retried.
4. **Send reconciler (alarm in B, cron in C), two jobs only:** re-enqueue a Send that is `QUEUED` with no `enqueuedAt` and older than 1 min (the lost hand-off), and record `FAILED` / `OUTCOME_UNKNOWN` for a Send still `QUEUED` at `deadline + 1 h` (backstop for a message lost after the hand-off).
5. **DLQ consumer:** records `FAILED` / `OUTCOME_UNKNOWN` for messages that exhausted `max_retries`.
6. **Recording outcomes:** conditional; the first final outcome wins, except that a later `SENT` overrides `FAILED` / `OUTCOME_UNKNOWN`.

## Comparison

Legend: ✅ good, ⚠️ trade-off or needs extra care, ❌ bad or missing.

| Aspect | A | B | C | D | E | F | G | H | I | J | K |
| - | - | - | - | - | - | - | - | - | - | - | - |
| Source of truth for Draft state | ✅ D1 | ⚠️ DOs + derived D1 copy | ✅ D1 | ❌ D1 + Workflow state | ✅ one DO | ⚠️ DOs + derived D1 copy | ❌ DOs + Sender outbox + D1 copy | ✅ Postgres | ⚠️ DOs + derived D1 copy | ✅ D1 | ✅ D1 |
| Pending list right after a Submission | ⚠️ replica lag¹ | ⚠️ projection + replica lag¹ | ⚠️ replica lag¹ | ⚠️ replica lag¹ | ✅ strong | ⚠️ projection + replica lag¹ | ⚠️ projection + replica lag¹ | ✅ strong | ⚠️ projection + replica lag¹ | ⚠️ replica lag¹ | ⚠️ replica lag¹ |
| Pending list right after a verdict, in the same browser | ✅ bookmark | ✅ projection written first + bookmark | ✅ bookmark | ✅ bookmark | ✅ strong | ⚠️ projection lag | ⚠️ projection lag | ✅ strong | ⚠️ projection lag | ✅ bookmark | ✅ bookmark |
| List read latency for far-away users | ✅ nearby replica | ✅ nearby replica | ✅ nearby replica | ✅ nearby replica | ⚠️ one location | ✅ nearby replica | ✅ nearby replica | ⚠️ one primary | ✅ nearby replica | ✅ nearby replica | ✅ nearby replica |
| Write latency for far-away users | ⚠️ one primary | ✅ near the creating Agent² | ⚠️ one primary | ⚠️ one primary | ⚠️ one location | ✅ near the creating Agent² | ✅ near the creating Agent² | ⚠️ one primary | ✅ near the creating Agent² | ⚠️ one primary | ⚠️ one primary |
| Write throughput | ⚠️ one primary | ✅ scales per Draft | ⚠️ one primary | ⚠️ one primary | ⚠️ one instance | ✅ scales per Draft | ✅ scales per Draft | ✅ high, vertical | ✅ scales per Draft | ⚠️ one primary | ⚠️ one primary |
| Delay until the first send attempt | ✅ immediate (inline)³ | ✅ immediate | ✅ immediate | ✅ immediate | ✅ immediate | ✅ immediate | ✅ immediate | ⚠️ up to 1 min³ | ✅ immediate | ✅ about 1 s (wake) | ✅ about 1 s (wake) |
| Resend calls from one place, concurrency and pacing controlled | ⚠️ cron yes, inline attempts no | ✅ paced consumer | ✅ paced consumer | ❌ every instance on its own | ✅ one loop | ❌ every Draft on its own | ✅ one Sender DO | ⚠️ cron yes, inline attempts no | ✅ paced consumer | ✅ one loop | ✅ paced dispatch + consumer |
| Approval and Send intent committed atomically | ✅ same DB | ✅ same DO step | ✅ same DB | ✅ same DB | ✅ same DO step | ✅ same DO step | ✅ same DO step | ✅ same DB | ✅ same DO step | ✅ same DB | ✅ same DB |
| Hand-off after that commit | ⚠️ inline attempt is best effort; the cron recovers it (≤ 1 min) | ⚠️ inline enqueue is best effort; the reconciler alarm recovers it (≤ ~1 min) | ⚠️ inline enqueue is best effort; the reconciler cron recovers it (≤ ~2 min) | ⚠️ inline create is best effort; the reconciler cron recovers it (≤ ~2 min) | ✅ none needed (alarm set in the same storage step) | ✅ none needed for the Send (alarm in the same step); the alarm recovers the projection | ⚠️ hand-off to the Sender DO is best effort; the Draft DO alarm recovers it | ✅ none needed (the cron reads the database directly) | ❌ inline enqueue is best effort; nothing recovers it | ⚠️ wake is best effort; the heartbeat recovers it (≤ 1 min) | ⚠️ wake and enqueue are best effort; heartbeat and lease expiry recover them (≤ ~2 min) |
| Draft can get stuck in `QUEUED` | ✅ no | ✅ no (backstop at deadline + 1 h) | ✅ no (backstop at deadline + 1 h) | ⚠️ only if the reconciler misses errored instances | ✅ no | ✅ no | ✅ no | ✅ no | ❌ yes | ✅ no | ✅ no |
| Retry timing | ⚠️ one clock, 1-min granularity | ✅ one clock (message delay), exact | ✅ one clock (message delay), exact | ✅ step retry config, exact | ✅ one clock, exact | ✅ one clock, exact | ✅ one clock, exact | ⚠️ one clock, 1-min granularity | ✅ one clock, exact | ✅ one clock, exact | ✅ one clock, exact |
| Duplicate Resend calls in normal operation⁴ | ✅ rare | ⚠️ by design (redelivery, re-enqueue) | ⚠️ by design (redelivery, re-enqueue) | ⚠️ by design (step retries) | ✅ rare | ✅ rare | ✅ rare | ✅ rare | ⚠️ by design | ✅ rare (DO reset only) | ⚠️ by design (fenced by `attempt`) |
| Moving parts | ✅ D1, cron | ❌ DOs, alarm, Queue, consumer, DLQ, projection | ⚠️ D1, Queue, consumer, cron, DLQ | ⚠️ D1, Workflow, cron | ✅ one DO | ⚠️ DOs, projection | ❌ DOs, Sender DO, projection | ⚠️ external DB, Hyperdrive, cron | ⚠️ like B minus alarm | ✅ D1, one DO | ⚠️ D1, DO, Queue, consumer, DLQ |
| Cross-Draft queries (lists, filters, "stuck > 1 h" alerts) | ✅ any SQL | ⚠️ projection only; DOs cannot be enumerated | ✅ any SQL | ✅ any SQL | ✅ any SQL in the DO | ⚠️ projection only | ⚠️ projection only | ✅ any SQL | ⚠️ projection only | ✅ any SQL | ✅ any SQL |
| Schema migrations | ✅ one database | ❌ per object, lazily | ✅ one database | ✅ one database | ✅ one object | ❌ per object | ❌ per object | ✅ one database | ❌ per object | ✅ one database | ✅ one database |
| Transactional logic for the 05/06 rules | ⚠️ `batch()`, no branching | ✅ synchronous SQL, branching | ⚠️ `batch()` | ⚠️ `batch()` | ✅ synchronous SQL | ✅ synchronous SQL | ✅ synchronous SQL | ✅ interactive transactions | ✅ synchronous SQL | ⚠️ `batch()` | ⚠️ `batch()` |
| Resend calls isolated from user traffic and scheduling | ✅ | ✅ | ✅ | ✅ | ⚠️ same instance as all user traffic | ✅ | ✅ | ✅ | ✅ | ⚠️ inside the scheduler loop (10 s timeout bounds a stall) | ✅ |
| Background activity when idle | ⚠️ cron every minute | ✅ event-driven | ⚠️ cron every minute | ⚠️ cron every minute | ✅ event-driven | ✅ event-driven | ✅ event-driven | ⚠️ cron every minute | ✅ event-driven | ⚠️ heartbeat alarm every minute | ⚠️ heartbeat alarm every minute |
| Recovery when sending code crashes | ✅ next tick | ✅ Queue redelivery, DLQ | ✅ Queue redelivery, DLQ | ✅ step retry | ⚠️ own catch-and-reschedule | ⚠️ own catch-and-reschedule | ⚠️ own catch-and-reschedule | ✅ next tick | ✅ Queue redelivery | ⚠️ own catch-and-reschedule⁵ | ✅ Queue redelivery |
| One Send's attempts traceable in one place | ⚠️ inline + cron | ⚠️ DO, Queue, consumer | ⚠️ producer, Queue, consumer | ✅ instance dashboard | ✅ | ✅ per DO | ⚠️ Draft DO + Sender DO | ✅ | ⚠️ DO, Queue, consumer | ✅ one loop | ⚠️ DO + consumer |
| Inspecting and fixing data | ✅ D1 console, Time Travel | ⚠️ per object | ✅ D1 | ✅ D1 | ⚠️ admin code only | ⚠️ per object | ⚠️ per object | ✅ any Postgres tool | ⚠️ per object | ✅ D1 | ✅ D1 |
| Local testability | ✅ `scheduled()` callable | ⚠️ Queue redelivery fidelity unknown | ⚠️ Queue fidelity unknown | ⚠️ Workflow fidelity unknown | ✅ `runDurableObjectAlarm` | ✅ `runDurableObjectAlarm` | ✅ `runDurableObjectAlarm` | ⚠️ needs a Postgres in tests | ⚠️ Queue fidelity unknown | ✅ `runDurableObjectAlarm` | ⚠️ Queue fidelity unknown |
| Stays on Cloudflare | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ extra provider | ✅ | ✅ | ✅ |

1. List reads use D1 read replicas through the Sessions API, so a just-submitted Draft can appear with a short delay for other readers. A client that passes the bookmark of its own write sees that write (read-your-writes); a Reviewer in a separate session may not. Decision-bearing operations (verdicts, Send claims) stay conditional writes on the primary, so a lagging list can at most show a row that is already decided or superseded, never cause a wrong Send. In B, F, G and I the projection lag comes on top.
2. Writes are fast for the Agent that created the Draft (the DO lives near it); a Reviewer elsewhere still pays one round trip per verdict, and in B a verdict additionally waits for the projection write on the D1 primary while that Draft's DO blocks other requests.
3. A with the inline `waitUntil` attempt; without it (and H as described), the first attempt waits for the next cron tick, up to 1 min.
4. Every duplicate is absorbed by the lease or fence plus the Resend idempotency key; "by design" means the path exists in normal operation and must be tested.
5. An additional cron that pokes the Sender DO would make J independent of its own alarm chain.

## Observations

- E, and every D1-based option (A, C, D, J, K), share the same single-location write latency, because a D1 database is one Durable Object underneath.
- Only per-Draft DOs (B, F, G, I) buy write locality and scale, and they all pay with a projection as the only catalog, per-object migrations, and projection lag on top of replica lag in the list.
- With list reads on D1 read replicas, every option except E and H trades a short list lag for local read latency; the D1 options keep the lag to replica lag alone.
- I is the only option with an unclosed gap; D is the only D1 option with two sources of truth for the Send.
