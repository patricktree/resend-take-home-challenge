# Drafts

## Tests

- Race tests that need a deterministic interleaving live in this suite (`test/`): `useBindings()` gives each test fresh D1 and R2 bindings in Wrangler's local test runtime, and `createHoldingD1Database()` wraps `DB` so a test holds a chosen statement or batch (`holdNext()`, then `release()`) while another use case commits. A held call also reveals its SQL, which `test/list-drafts.test.ts` and `test/send-reconciler.test.ts` run through `EXPLAIN QUERY PLAN` to pin their index use.
- The Approval and the Send reconciler (`reconcileSends()`) take the Send Queue as a parameter, so drafts tests pass `createRecordingSendQueue()` or `createFailingSendQueue()` (`test/recording-send-queue.ts`), which cover both `send()` and `sendBatch()`; like Cloudflare Queues, the recording double refuses a `sendBatch()` over 100 messages or 256 KB of bodies, which the local test runtime does not enforce. Production code has no test hooks.
- Build a fixture of dozens of Drafts with one D1 `batch()` of inserts, such as `seedApprovedDrafts()` in `test/send-reconciler.test.ts` or `insertDrafts()` in `apps/cloudflare-worker/test/lists.test.ts`: that many use cases or requests one after the other approach the 30 s test timeout on a loaded machine, such as during `pnpm validate:fast`, which runs every suite at once. Seeded approved Drafts stay pinned to a real Approval's rows by the test "a seeded approved Draft has the rows a real Approval writes".

## Queries

- A query meant to use a partial index must spell out the index's `WHERE` terms with literal values (see `IS_QUEUED` in `src/send-reconciler.ts`): SQLite does not match a bound parameter, such as the one `eq()` binds, against a partial index's `WHERE`.
- Inside a D1 `batch()`, Drizzle maps a joined select by column name, so columns both tables have (such as `id`) overwrite each other; batch single-table selects instead (see `src/get-draft.ts`).

## Migrations

D1 migrations live in `migrations/`; every Wrangler config points `migrations_dir` there. They are generated from the Drizzle schema in `src/schema.ts`: after changing it, run `pnpm --filter '@resend-challenge/drafts' migrations:generate --name <change>` and commit the new SQL file with the updated `meta/` files; never edit a generated migration.
