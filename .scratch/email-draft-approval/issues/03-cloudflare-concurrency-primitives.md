# Cloudflare primitives for exactly-once and concurrency

Type: research
Status: resolved
Blocked by:

## Question

What guarantees do Cloudflare's storage and messaging primitives give under concurrent requests and retries? Cover: D1 (transactions or batches, isolation, unique constraints, conditional updates, read replication effects); Durable Objects (single-threaded execution, input/output gates, transactional storage, SQLite-backed storage, alarms); Queues (at-least-once delivery, retries, dead-letter queues); Workflows (step retries, step-level idempotency, durability); Workers' own retry behaviour on failure. For each: what can and cannot be guaranteed for 'perform an external side effect (an HTTP call to Resend) at most once per key'. Primary sources: developers.cloudflare.com.

## Answer

- No Cloudflare primitive makes an outbound HTTP call exactly once. Queues, DO alarms and Workflow steps are documented as at-least-once; the Worker `fetch` handler is not retried at all and can be cut off (client disconnect, 30 s `waitUntil` cap, runtime-update drain).
- The platform does provide an atomic, durable **claim** per key. That guarantees at most one actor _attempts_ the Send under concurrency and retries.
- D1: one single-threaded database, so queries are effectively serialized. `batch()` is an atomic transaction, but there are no interactive transactions. Use a conditional `UPDATE ... WHERE state='approved'` checked via `meta.changes`, or a `UNIQUE` insert. Read replicas lag arbitrarily, so decision-bearing reads must hit the primary. Writes are not auto-retried, and a transient error leaves the outcome unknown.
- Durable Objects: globally unique per ID, single-threaded, synchronous SQLite (check + claim cannot interleave). Output gates hold outbound `fetch` until prior writes are durable, so the claim is persisted before Resend sees the request. `await fetch` reopens the input gate, so the persisted state (not memory) must be the guard.
- DO shutdown can let an old instance finish a storage-free `fetch` it cannot record. After a reset, a `sending` Draft has an unknown outcome.
- DO alarms: one per object, at-least-once, 6 retries with backoff from 2 s; they are a good durable Send/recovery driver if the handler is idempotent.
- Queues: at-least-once, no ordering, no dedup, whole-batch retry unless acked, DLQ or permanent deletion after `max_retries`. Docs explicitly recommend passing a message ID as the email API's idempotency key.
- Workflows: successful steps are cached by deterministic name. A step is retried (default 5 retries, 10 s exponential), so a step whose call reached Resend but whose result was not persisted runs again. The instance ID deduplicates `create` within the retention window (3/30 days).
- Consequence: the crash window between "claim committed" and "Resend result recorded" is closed only by Resend's idempotency key derived from the Draft. Without it, the design is at-most-once and can lose a Send.

[findings](../research/cloudflare-concurrency-primitives.md)
