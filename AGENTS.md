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

`pnpm dev` applies the local D1 migrations and starts Vite with the Worker. Locally, call the API with `LOCAL_AGENT_TOKEN` or `LOCAL_REVIEWER_TOKEN` from `libs/api.routes/src/local-tokens.ts`.

## Validation

| Command                  | Runs                                                                                    | Needs                          |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------ |
| `pnpm validate:fast`     | Format check, markdownlint, Knip, build and typecheck, lint, unit and integration tests | Nothing beyond the setup above |
| `pnpm validate:extended` | e2e tests (none exist yet, so it passes trivially)                                      | Docker, once e2e tests exist   |

Run `pnpm validate:fast` before every commit and both before opening a pull request. Use `pnpm fix` to apply formatting and autofixable lint findings. There are no Git hooks.

## Conventions

- Work test-first: a failing test, then the code that makes it pass. Integration tests come first, through the `useWorker()` fixture in `apps/cloudflare-worker/test/use-worker.ts` (one Worker per test, concurrent within a file, migrations applied, empty storage).
- Race tests that need a deterministic interleaving live in the drafts suite (`libs/drafts/test/`): `useBindings()` gives each test fresh D1 and R2 bindings in Wrangler's local test runtime, and `createGatedD1Database()` wraps `DB` so a test holds a chosen statement or batch (`holdNext()`, then `release()`) while another use case commits. Production code has no test hooks.
- Fix the underlying cause of every lint, type or test failure; lint rules, type checks and tests stay enabled, with no disable comments, `@ts-expect-error`, skipped tests or Knip ignores for real findings.
- "Harness" means an agent harness only; call a test setup a test runtime, fixture or test setup.
- Tests start their own servers on OS-assigned ports and never attach to a running server. Vitest runs with `retry: 0`.
- Mark every new kind of committed generated file `linguist-generated=true` in `.gitattributes`, so pull request diffs and agent reviews (`git diff -- . ':(exclude,attr:linguist-generated=true)'`) leave it out. The OpenAPI snapshot (`apps/cloudflare-worker/test/__snapshots__/openapi.json`) is one; regenerate it with `pnpm --filter '@draft-approval/cloudflare-worker' test -u` rather than editing it.
- D1 migrations live in `libs/drafts/migrations/`; every Wrangler config points `migrations_dir` there. They are generated from the Drizzle schema in `libs/drafts/src/schema.ts`: after changing it, run `pnpm --filter '@draft-approval/drafts' migrations:generate --name <change>` and commit the new SQL file with the updated `meta/` files; never edit a generated migration.
- Clients of the API use the typed client `DraftApprovalClient` from `libs/api.client`; it keeps and resends the read bookmark and throws `ApiError` for error responses.
- `apps/review-ui`, `apps/cli`, `libs/mcp-server` and `qa/e2e` are placeholders (a `package.json` only) until their tickets fill them.
- `apps/cloudflare-worker/wrangler.jsonc` is the production config and the one `pnpm dev` uses; `apps/cloudflare-worker/test/wrangler-config.test.ts` pins the settings the spec prescribes. Its resources come from `terraform/` (providers pinned, lock file committed). After changing `terraform/`, run `terraform -chdir=terraform fmt` and `terraform -chdir=terraform init -backend=false && terraform -chdir=terraform validate`; they need Terraform 1.10 or newer and are not part of `pnpm validate:fast`.
- The README's [Human steps](README.md#human-steps) are the deploy procedure; `pnpm secrets:generate` belongs to them, since it sets a production secret.
- Never deploy or touch real Cloudflare or Resend resources (`wrangler deploy`, `wrangler login`, `wrangler secret put`, `wrangler d1 migrations apply --remote`, `pnpm secrets:generate`, `terraform init` with the real backend, `terraform apply`) unless Patrick asks.
