# Cloudflare primitives for exactly-once and concurrency

Research for [ticket 03](../issues/03-cloudflare-concurrency-primitives.md).
Sources: developers.cloudflare.com (pages fetched 2026-10-20 as Markdown via `<page>/index.md`) and one Cloudflare engineering blog post.
"Inference" marks conclusions not stated verbatim in the docs.

## Bottom line

No Cloudflare primitive can make an outbound HTTP call happen exactly once.
Every retrying primitive (Queues, Durable Object alarms, Workflow steps) is documented as at-least-once, and the plain Worker `fetch` handler is not retried at all.
What the platform *can* give is an atomic, durable **claim**: a compare-and-set on a per-key row so that, among concurrent or retried actors, only one ever proceeds to call Resend.
The remaining gap is the crash window between "claim committed" and "Resend response recorded".
The platform cannot close that window; Resend's idempotency key has to (retry the same call with the same key), or the design accepts at-most-once and may lose a Send.

## D1

Documented guarantees:

- `batch()` runs a list of statements "sequentially, non-concurrently", and "Batched statements are SQL transactions": a failing statement aborts or rolls back the whole sequence. D1 otherwise runs in auto-commit. [D1Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- There is no interactive transaction in the Worker API (no `BEGIN`/`COMMIT` across awaits); `batch()` is the only multi-statement atomic unit. Inference from the API surface; the DO SQL API explicitly forbids `BEGIN TRANSACTION`/`SAVEPOINT` in `exec()` ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec)), and D1 is built on DOs.
- Isolation: "Each individual D1 database is inherently single-threaded, and processes queries one at a time." Each D1 database is backed by a single Durable Object. Overload: requests queue, then fail with an "overloaded" error. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
  - Inference: every statement and every batch is effectively serializable against the primary.
- Unique constraints and conditional updates: standard SQLite semantics. Result `meta.changes` reports rows changed, so `UPDATE drafts SET state='sending' WHERE id=? AND state='approved'` with `changes === 1` is an atomic claim. [Return object](https://developers.cloudflare.com/d1/worker-api/return-object/)
- Read replication: replicas are asynchronous and "may be arbitrarily out of date"; all writes go to the primary. Only queries through the Sessions API use replicas; without `withSession()` everything hits the primary. Sessions give sequential consistency; `first-primary` starts at the latest version; bookmarks carry consistency across requests. `meta.served_by_primary` tells where a query ran. [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), [withSession](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)
- Retries: D1 auto-retries **read-only** queries up to two more times and rolls back any write a retry causes. Writes are not auto-retried. Errors such as `Network connection lost` or `D1 DB reset` are transient, and D1 says retrying is only safe if the query is idempotent. [Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/#automatic-retries), [Retry queries](https://developers.cloudflare.com/d1/best-practices/retry-queries/)

For "Send at most once per Draft":

- Can: an atomic claim (conditional `UPDATE ... WHERE state='approved'` checked via `meta.changes`, or `INSERT` into a table with a `UNIQUE(draft_id)` constraint), so concurrent Approvals or retries elect exactly one sender.
- Can: make the verdict and the state change atomic in one `batch()`.
- Cannot: hold a transaction open across the Resend `fetch`. The claim and the "sent" record are two separate commits.
- Cannot: tell you, after a transient write error, whether the write committed. Make the write idempotent (a conditional update) and re-read the row.
- Watch out: a replica read may show a stale `approved` state; make any decision-bearing read go to the primary (no Session, or `first-primary`), or fold the check into the conditional write.

## Durable Objects

Documented guarantees:

- Globally unique per ID: for `idFromName`, "the system must check that the Durable Object has not been created anywhere else" so only one instance exists. [Namespace](https://developers.cloudflare.com/durable-objects/api/namespace/#idfromname)
- Single-threaded and cooperatively multitasked. [What are DOs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- Input gates: no new events are delivered while a storage operation is in progress. But `await fetch()` and other non-storage I/O **open** the gate, so other requests can interleave. The docs' own example is a check-then-fetch race; they recommend optimistic check-and-set. [Rules of DOs: gates](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-how-input-and-output-gates-work), [non-storage I/O](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#avoid-race-conditions-with-non-storage-io)
- Output gates: outgoing messages, **including outbound `fetch()` requests**, are held until all earlier storage writes are confirmed durable. If a write fails, the held messages are discarded. [Blog: Easy, Fast, Correct](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
  - Inference: writing `state='sending'` and then calling `fetch(resend)` guarantees the claim is durable before Resend ever sees the request.
- SQLite storage: `sql.exec()` is synchronous; "SQLite storage operations are synchronous and do not yield the event loop, so they execute atomically". `transactionSync(cb)` rolls back if `cb` throws. Writes with no intervening `await` are submitted atomically. [State: blockConcurrencyWhile](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile), [transactionSync / transaction](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync)
- `blockConcurrencyWhile(cb)` blocks all other events even across async I/O, with a 30 s timeout. A throw or timeout resets the object. Docs advise reserving it for the constructor or rare cases. [State API](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)
- Shutdown/restart (deploys, runtime updates, relocation, idleness): new requests go to a new instance. In-flight requests on the old instance may finish **if they do not touch storage**; a storage access is stopped with an error "to maintain Durable Objects global uniqueness property". [Lifecycle: shutdown](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior)
  - Inference: briefly, an old instance can still be awaiting a Resend `fetch` while a new instance serves requests. The old instance cannot record the result, so the new one sees `sending` with no outcome.
- Errors from DO calls propagate to the caller; `.retryable` errors should be retried only if the request is idempotent; `.overloaded` should not be retried. The caller cannot tell whether the DO executed the call before the error. [Error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
- Alarms: one alarm per object at a time; "guaranteed at-least-once execution"; retried on throw with exponential backoff from 2 s, up to 6 retries; only one `alarm()` runs at a time per object; `alarmInfo.retryCount`/`isRetry` are exposed. After 6 failures it stops until `setAlarm` is called again; docs suggest catching and rescheduling. Wall time per alarm invocation is 15 min. [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Queues limits: wall time table](https://developers.cloudflare.com/queues/platform/limits/#wall-time-limits-by-invocation-type)
- Limits: 30 s CPU per request by default (configurable to 5 min); storage up to 10 GB per object; `waitUntil` and outbound I/O keep an object alive for up to 15 min per operation. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

For "Send at most once per Draft" (one DO per Draft):

- Can: serialize every command for a Draft (Revise, Approve, Reject, Send) through one instance, and make check + claim one synchronous SQL step that no other request can interleave with.
- Can: guarantee via output gates that the claim is durable before the Resend request leaves.
- Can: drive the Send or its recovery with an alarm (at-least-once, so the alarm handler must be idempotent).
- Cannot: stop interleaving during the `await fetch(resend)` itself (unless `blockConcurrencyWhile`, which still does not survive a reset). The persisted `sending` state must be the guard, not in-memory flags.
- Cannot: know after a reset whether a `sending` Draft's call reached Resend. Recovery needs Resend's idempotency key, or must give up (at-most-once).

## Queues

Documented guarantees:

- "Queues provides at least once delivery by default"; messages "may be delivered more than once". Docs recommend a unique ID per message and passing it as the idempotency key to "an upstream email API". [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- No ordering guarantee. One active consumer per queue. [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- Retries: failed delivery is retried `max_retries` times (default 3, max 100). An unacknowledged failure retries the **whole batch** unless messages were individually `ack()`ed. `retry()` can take a delay (up to 24 h). After the last retry the message goes to the DLQ if one is configured, otherwise it is permanently deleted. [Batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), [Limits](https://developers.cloudflare.com/queues/platform/limits/)
- Retention configurable up to 14 days (24 h on Free); consumer wall time 15 min; up to 250 concurrent push consumer invocations, so duplicates can be processed **concurrently**. [Limits](https://developers.cloudflare.com/queues/platform/limits/)
- Docs point `waitUntil` overflow work at Queues for "reliable delivery and automatic retries". [Context API](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

For "Send at most once per Draft":

- Can: guarantee the Send is eventually *attempted* (durable hand-off, retries, DLQ for human follow-up).
- Cannot: deduplicate. There is no documented dedup ID or exactly-once mode. Duplicates must be absorbed by a durable claim (D1 or DO) plus the Resend idempotency key.
- Note: `queue.send()` failing in the producer does not say whether the message was enqueued (inference; not documented either way).

## Workflows

Documented guarantees:

- Steps are "individually retryable"; a successful `step.do` result is persisted and cached by **step name**, so it is not re-run on replay. Names must be deterministic. [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#name-steps-deterministically)
- A step "might be retried multiple times", so it should be idempotent. The official example is: inside the step, first ask the external service whether the action already happened, then do it. The comment notes the service may "commit" a request whose response was lost. [Rules: idempotent calls](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#ensure-apibinding-calls-are-idempotent)
- Code outside `step.do` may run more than once when the engine restarts. [Rules: side effects outside steps](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#avoid-doing-side-effects-outside-of-a-stepdo)
- Default step retry config: `limit: 5`, `delay: 10000` ms, `exponential`, `timeout: "10 minutes"` per attempt. Configurable up to 10,000 retries. `NonRetryableError` stops retries. [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- Instance ID as a dedup key: `create({ id })` throws if the ID is already used by an instance within its retention period. `createBatch` reports `10405` "already exists" instead. Max ID length 100 chars; retention 3 days (Free) / 30 days (Paid). [Workers API: create](https://developers.cloudflare.com/workflows/build/workers-api/#create), [Limits](https://developers.cloudflare.com/workflows/reference/limits/)
- `restart` (optionally `from` a step) re-runs that step and later ones. A manual restart is a deliberate re-send path. [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)

For "Send at most once per Draft":

- Can: give one durable, retried Send per Draft by using the Draft ID (or `draft_id:revision_id`) as the instance ID. A concurrent second `create` fails while the instance is retained.
- Can: skip the Send step on replay once it has succeeded and recorded its result.
- Cannot: protect the crash window inside the step. A step whose `fetch` reached Resend but whose result was not persisted is retried, so the step must send with the same Resend idempotency key, or check first.
- Cannot: deduplicate past the retention window (inference: after expiry the ID can be reused).

## Workers (fetch handler) retry behaviour

- No documented automatic retry of a failed or crashed `fetch` invocation by the platform. Retries come from the client (here: the Reviewer UI, an Agent, or the HTTP client library). Inference from the absence of any such mechanism in the handler docs. [Fetch handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/)
- Work can be cut off. When the client disconnects or the response completes, unawaited tasks may be cancelled. `waitUntil` extends that by at most 30 s. Runtime updates give old processes up to 20 min to drain, then terminate remaining requests. "Crashes, resource pressure, and shutdowns can interrupt work earlier. Design long-running applications to handle disconnections and safely retry interrupted work." [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#runtime-updates), [Context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)
- `Network connection lost` on a subrequest or binding: "Catch ... and retry it". The outcome on the far side is unknown. [Errors](https://developers.cloudflare.com/workers/observability/errors/)

For "Send at most once per Draft": a request-scoped Worker (or `waitUntil`) gives neither durability nor retry for the Send. If it dies after claiming, nothing resumes the Send unless something durable (an alarm, a queue, or a Workflow) owns it.

## Implications for the design (synthesis)

1. **Concurrency guard:** a durable compare-and-set on the Draft (DO with synchronous SQLite, or a D1 conditional `UPDATE` / `UNIQUE` insert on the primary). Either works; the DO additionally serializes all Draft commands and has output gates.
2. **Durable driver:** something at-least-once must own the Send after the claim: a DO alarm, a Queue message, or a Workflow step. All three can run the Send more than once.
3. **Ambiguous outcome:** every driver can retry a Send whose earlier attempt actually reached Resend. Only an idempotency key derived from the Draft (for example the Draft ID) makes retries safe. Resend's idempotency semantics and window are a separate question and need their own research.
4. **Decision-bearing reads:** never trust in-memory state or D1 read replicas to decide whether to send; decide inside the atomic write.

## Unknowns

- Whether a DO `fetch` that was in flight on an instance being shut down is guaranteed to have been sent or not sent. The docs say in-flight requests "are allowed to finish if they do not access storage", which implies the call can complete with no way to record its result.
- Whether a Workflow step whose attempt timed out (`timeout`) is cancelled before the retry starts, or can still be running concurrently with the retry. Not documented.
- Whether a failed `queue.send()` may still have enqueued the message. Not documented.
- D1 has no documented statement on whether a write that returned `Network connection lost` committed. Assume it may have.
- The exact consistency between D1's primary and a just-relocated primary, or failover behaviour. Not documented beyond "single Durable Object".
- How faithfully the local runtime (Miniflare / `@cloudflare/vitest-pool-workers`) reproduces input/output gates, alarm retries, and Queue redelivery. Matters for the testing ticket; not covered here.
