# Agent Instructions

## Read first

1. [GLOSSARY.md](GLOSSARY.md): the domain terms; use them in code, tests and docs.
2. [The spec](.scratch/email-draft-approval/spec.md): authoritative for every decision.
3. [The tickets](.scratch/email-draft-approval-build/issues/): one file per slice; `**Blocked by:**` lines form the task graph.
4. [The design decisions](.scratch/email-draft-approval/issues/): the reasoning behind the spec. Where one disagrees with the spec, the spec wins.

## Environment setup

On a fresh checkout or worktree:

```sh
git submodule update --init --recursive
source ~/.nvm/nvm.sh && nvm install
corepack enable
pnpm install
cp apps/cloudflare-worker/.dev.vars.example apps/cloudflare-worker/.dev.vars
```

The `.patricktree-stack` submodule holds the shared configs; if it is missing, `pnpm install` initializes it and fails once, so retry. `pnpm install` also generates the Worker types (`worker-configuration.d.ts`, not committed); run `pnpm cf-typegen` after changing a Wrangler config. `.dev.vars` (gitignored) is only needed for `pnpm dev`; tests never read it.

`pnpm dev` applies the local D1 migrations and starts Vite with the Worker. Locally, call the API with `LOCAL_AGENT_TOKEN` or `LOCAL_REVIEWER_TOKEN` from `libs/api.routes/src/local-tokens.ts`. With `pnpm dev` running, `pnpm seed` (`tooling/seed`) creates Pending, Rejected and Approved Drafts through the typed client; it calls `http://localhost:5173` unless given `--base-url` or `DRAFT_APPROVAL_BASE_URL`.

## Validation

| Command                  | Runs                                                                                                 | Needs                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------ |
| `pnpm validate:fast`     | Format check, markdownlint, Knip, build and typecheck, lint, unit, integration and CLI process tests | Nothing beyond the setup above |
| `pnpm validate:extended` | e2e tests (none exist yet, so it passes trivially)                                                   | Docker, once e2e tests exist   |

Run `pnpm validate:fast` before every commit and both before opening a pull request. Use `pnpm fix` to apply formatting and autofixable lint findings. There are no Git hooks.

## Conventions

- Work test-first: a failing test, then the code that makes it pass. Integration tests come first, through the `useWorker()` fixture in `apps/cloudflare-worker/test/use-worker.ts` (one Worker per test, concurrent within a file, migrations applied, empty storage).
- Race tests that need a deterministic interleaving live in the drafts suite (`libs/drafts/test/`): `useBindings()` gives each test fresh D1 and R2 bindings in Wrangler's local test runtime, and `createGatedD1Database()` wraps `DB` so a test holds a chosen statement or batch (`holdNext()`, then `release()`) while another use case commits. A held call also reveals its SQL, which `libs/drafts/test/list-drafts.test.ts` runs through `EXPLAIN QUERY PLAN` to pin the list's index use. The Approval takes the Send Queue as a parameter, so drafts tests pass `createRecordingSendQueue()` or `createFailingSendQueue()` (`libs/drafts/test/recording-send-queue.ts`). Production code has no test hooks.
- Integration tests count Send Queue messages with `readSentSendQueueMessages(worker)`: the test entry point `apps/cloudflare-worker/test/worker.ts` wraps `SEND_QUEUE` in a recording double before delegating to the production `fetch`, and exposes the recording as an RPC method, not a route.
- Inside a D1 `batch()`, Drizzle maps a joined select by column name, so columns both tables have (such as `id`) overwrite each other; batch single-table selects instead (see `libs/drafts/src/get-draft.ts`).
- Fix the underlying cause of every lint, type or test failure; lint rules, type checks and tests stay enabled, with no disable comments, `@ts-expect-error`, skipped tests or Knip ignores for real findings.
- "Harness" means an agent harness only; call a test setup a test runtime, fixture or test setup.
- Tests start their own servers on OS-assigned ports and never attach to a running server. Vitest runs with `retry: 0`.
- Mark every new kind of committed generated file `linguist-generated=true` in `.gitattributes`, so pull request diffs and agent reviews (`git diff -- . ':(exclude,attr:linguist-generated=true)'`) leave it out. The OpenAPI snapshot (`apps/cloudflare-worker/test/__snapshots__/openapi.json`) is one; regenerate it with `pnpm --filter '@draft-approval/cloudflare-worker' test -u` rather than editing it.
- D1 migrations live in `libs/drafts/migrations/`; every Wrangler config points `migrations_dir` there. They are generated from the Drizzle schema in `libs/drafts/src/schema.ts`: after changing it, run `pnpm --filter '@draft-approval/drafts' migrations:generate --name <change>` and commit the new SQL file with the updated `meta/` files; never edit a generated migration.
- Clients of the API use the typed client `DraftApprovalClient` from `libs/api.client`; it keeps and resends the read bookmark and throws `ApiError` for error responses.
- The MCP server lives in two places: `libs/mcp-server` holds the six tools on the typed client, and `libs/api.server/src/mcp-endpoint.ts` mounts them at `/mcp` (stateless `createMcpHandler` from `agents/mcp/server`, Agent token only). Each request builds a `DraftApprovalClient` with the caller's token whose `fetch` calls the Hono app in-process, so tool calls pass the API's own checks. Tests drive `/mcp` with the official MCP SDK client (`apps/cloudflare-worker/test/mcp.test.ts`).
- `agents` and the MCP SDK packages sit in the `mcp` catalog of `pnpm-workspace.yaml`: `agents` names exact versions of `@modelcontextprotocol/server` and `@modelcontextprotocol/client` as peer dependencies, so upgrade the three together. `libs/api.server` lists `@modelcontextprotocol/client`, `@modelcontextprotocol/server` and `zod` only to provide those peers (pnpm installs no peers on its own here); its code imports none of them.
- `apps/review-ui` and `qa/e2e` are placeholders (a `package.json` only) until their tickets fill them.
- The Agent CLI lives in `apps/cli` and runs as `pnpm draft-approval …` from the repository root. Its process tests in `apps/cli/test/` spawn the real CLI against a `node:http` API stub (`useApiStub()` in `apps/cli/test/api-stub.ts`) and pass it its whole environment, so `DRAFT_APPROVAL_TOKEN` and `DRAFT_APPROVAL_API_URL` never leak in. Its fallback token `PUBLIC_AGENT_TOKEN` and production URL in `apps/cli/src/production.ts` must equal `AGENT_TOKEN` and `PUBLIC_BASE_URL` in `wrangler.jsonc`; `pnpm secrets:generate` rewrites the token in both.
- `apps/cloudflare-worker/wrangler.jsonc` is the production config and the one `pnpm dev` uses; `apps/cloudflare-worker/test/wrangler-config.test.ts` pins the settings the spec prescribes. Its resources come from `terraform/` (providers pinned, lock file committed). After changing `terraform/`, run `terraform -chdir=terraform fmt` and `terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate`; they need Terraform 1.10 or newer and are not part of `pnpm validate:fast`.
- The README's [Human steps](README.md#human-steps) are the deploy procedure; `pnpm secrets:generate` belongs to them, since it sets a production secret.
- Never deploy or touch real Cloudflare or Resend resources (`wrangler deploy`, `wrangler login`, `wrangler secret put`, `wrangler d1 migrations apply --remote`, `pnpm secrets:generate`, `terraform init` with the real backend, `terraform apply`) unless Patrick asks.
