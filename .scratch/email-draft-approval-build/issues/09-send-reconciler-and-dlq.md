# 09: Send reconciler and DLQ

**What to build:** No Send stays `QUEUED` forever: lost hand-offs are re-enqueued, crash-looping messages and lost messages are resolved, and a late `SENT` still wins. Spec: [Send reconciler](../../email-draft-approval/spec.md#send-reconciler), [DLQ consumer](../../email-draft-approval/spec.md#dlq-consumer), [Recording outcomes](../../email-draft-approval/spec.md#recording-outcomes), [Time](../../email-draft-approval/spec.md#time).

**Blocked by:** 08 (Send through Resend)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/12>)

- [x] `scheduled` runs both jobs, each at most 100 rows per tick, oldest first, via the partial indexes: re-enqueue `QUEUED` Sends without `enqueued_at` older than 1 min (one `sendBatch`, stop at the first failure); `FAILED` / `OUTCOME_UNKNOWN` at `deadline + 1 h`
- [x] DLQ consumer records `FAILED` / `OUTCOME_UNKNOWN`, `console.error`s, acks; test-only `/__test/dlq` route
- [x] A late `SENT` overrides `OUTCOME_UNKNOWN` and clears the failure fields; nothing else leaves a final status
- [x] Tests backdate rows and call `worker.scheduled()`: lost hand-off, 1 min threshold, backstop, reconciler re-enqueue ‖ consumer (one ledger email), late `SENT` ‖ deadline or DLQ failure (`SENT` wins), enqueue-failure stop
