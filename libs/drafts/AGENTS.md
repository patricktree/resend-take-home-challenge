# Drafts

## Layout

`src/index.ts` is the package's interface; `src/root-cause.ts` serves every log line. The folders:

- `domain/`: the Draft types, status values and `OutgoingEmail` (`draft.ts`), the ids, the 23 h Send deadline, and the refusal precedence of revise, Submission and verdict (`refusals.ts`) as pure functions. It imports nothing else from the package.
- `storage/`: the D1 and R2 adapter: the Drizzle schema, `drizzleForSession()`, the row-to-domain mapping (`draft-rows.ts`), the one read behind every refusal (`refusal-snapshot.ts`), the R2 bodies, and the Send outbox (`send-outbox.ts`), which owns every write and query of the outbox columns after the Approval batch.
- `review/`: the use cases of the review flow. Each mutation keeps its guarded batch inline, with Drizzle and no repository port: the guard and the statement order are the use case.
- `send/`: the Send pipeline: the Send Queue port and message schema (`send-queue.ts`, which imports only `domain/`, so `storage/send-outbox.ts` can build messages from rows), the Queue and DLQ consumers, the Send reconciler and the retry delay.
- `resend/`: the Resend adapter: the `POST /emails` call with `Retry-After` parsing, and the classification of its result.
- `worker/`: the Cloudflare glue: the env binding types, the queue names that must match `wrangler.jsonc`, and the `queue` and `scheduled` handlers, which build the consumers' and the reconciler's dependencies from the bindings. Only `index.ts` imports it.

Tests stay flat in `test/`.

## Tests

- Race tests that need a deterministic interleaving live in this suite (`test/`): `useBindings()` gives each test fresh D1 and R2 bindings in Wrangler's local test runtime, and `createHoldingD1Database()` wraps `DB` so a test holds a chosen statement or batch (`holdNext()`, then `release()`) while another use case commits. A held call also reveals its SQL, which `test/list-drafts.test.ts` and `test/send-reconciler.test.ts` run through `EXPLAIN QUERY PLAN` to pin their index use.
- The Approval and the Send reconciler (`reconcileSends()`) take the Send Queue as a parameter, so drafts tests pass `createRecordingSendQueue()` or `createFailingSendQueue()` (`test/recording-send-queue.ts`), which cover both `send()` and `sendBatch()`; like Cloudflare Queues, the recording double refuses a `sendBatch()` over 100 messages or 256 KB of bodies, which the local test runtime does not enforce. Production code has no test hooks.
- Build a fixture of dozens of Drafts with one D1 `batch()` of inserts, such as `seedApprovedDrafts()` in `test/send-reconciler.test.ts` or `insertDrafts()` in `apps/cloudflare-worker/test/lists.test.ts`: that many use cases or requests one after the other approach the 30 s test timeout on a loaded machine, such as during `pnpm validate:fast`, which runs every suite at once. Seeded approved Drafts stay pinned to a real Approval's rows by the test "a seeded approved Draft has the rows a real Approval writes".

## Queries

- A query meant to use a partial index must spell out the index's `WHERE` terms with literal values (see `IS_QUEUED` in `src/storage/send-outbox.ts`): SQLite does not match a bound parameter, such as the one `eq()` binds, against a partial index's `WHERE`.
- Inside a D1 `batch()`, Drizzle maps a joined select by column name, so columns both tables have (such as `id`) overwrite each other; batch single-table selects instead (see `src/review/get-draft.ts`).

## Migrations

D1 migrations live in `migrations/`; every Wrangler config points `migrations_dir` there. They are generated from the Drizzle schema in `src/storage/schema.ts`: after changing it, run `pnpm --filter '@resend-challenge/drafts' migrations:generate --name <change>` and commit the new SQL file with the updated `meta/` files; never edit a generated migration.
