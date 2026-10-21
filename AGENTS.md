# Agent Instructions

## Read first

1. [GLOSSARY.md](GLOSSARY.md): the domain terms; use them in code, tests and docs.
2. [The spec](.scratch/email-draft-approval/spec.md): authoritative for every decision.
3. [The tickets](.scratch/email-draft-approval-build/issues/): one file per slice; `**Blocked by:**` lines form the task graph.
4. [The design decisions](.scratch/email-draft-approval/issues/): the reasoning behind the spec. Where one disagrees with the spec, the spec wins.
5. The `AGENTS.md` of every package you change, listed under [Package instructions](#package-instructions).

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

`pnpm dev` applies the local D1 migrations and starts Vite with the Worker and the Review UI (<http://localhost:5173/app/>, hot reload). Locally, call the API with `LOCAL_AGENT_TOKEN` or `LOCAL_REVIEWER_TOKEN` from `libs/api.routes/src/local-tokens.ts`. With `pnpm dev` running, `pnpm seed` (`tooling/seed`) creates Pending, Rejected and Approved Drafts through the typed client; it calls `http://localhost:5173` unless given `--base-url` or `RESEND_CHALLENGE_BASE_URL`.

## Validation

| Command                  | Runs                                                                                     | Needs                          |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `pnpm validate:fast`     | Format check, Knip, build and typecheck, lint, unit, integration and CLI process tests   | Nothing beyond the setup above |
| `pnpm validate:extended` | Builds the Worker and runs the e2e tests (`qa/e2e`) with Playwright's browsers in Docker | Docker with host networking    |

Run `pnpm validate:fast` before every commit and both before opening a pull request. After an intended visual change, `pnpm validate:update-snapshots` (`validate:fast`, then the e2e tests with `--update-snapshots=changed`; `pnpm test:e2e:update` runs only the latter) rewrites the screenshot baselines in `qa/e2e/snapshots/`; review and commit them. Use `pnpm fix` to apply formatting and autofixable lint findings. There are no Git hooks.

`pnpm test:resend-live` (in `qa/resend-stub/test-live/`, its own Vitest config) is the opt-in contract test that checks the Resend stub's idempotency model against the real API. It needs `RESEND_API_KEY` (`RESEND_FROM` defaults to the one in `wrangler.jsonc`) and sends real emails to `delivered@resend.dev`, so it is part of no validation command and only the operator runs it.

## Conventions

- Work test-first: a failing test, then the code that makes it pass. Integration tests come first, through the `useWorker()` fixture of `apps/cloudflare-worker`.
- Fix the underlying cause of every lint, type or test failure; lint rules, type checks and tests stay enabled, with no disable comments, `@ts-expect-error`, skipped tests or Knip ignores for real findings.
- Lint settings live in `tooling/config-oxlint/oxlint-base.js` (`@resend-challenge/config-oxlint`), which every package's `oxlint.config.ts` extends: it turns on type-aware rules (`typeAware`) and fails on any warning (`maxWarnings: 0`); packages import their own modules relatively, with `.ts` / `.tsx` extensions, and have no `imports` field.
- Each package's `turbo:build` deletes `dist/types` and `dist/tsconfig.build.tsbuildinfo` before `tsc --build`: declarations of renamed or deleted modules would otherwise linger, and a build info file left without its declarations would make `tsc --build` skip the emit.
- "Harness" means an agent harness only; call a test setup a test runtime, fixture or test setup.
- Tests start their own servers on OS-assigned ports and never attach to a running server. Vitest runs with `retry: 0`.
- Every package whose tests run its code in Vitest's own process has `test:coverage` (`vitest run --coverage`). `apps/cloudflare-worker` and `apps/cli` have none: the Worker's code runs inside workerd and the CLI's in spawned processes, where Vitest's V8 coverage sees nothing.
- Mark every new kind of committed generated file `linguist-generated=true` in `.gitattributes`, so pull request diffs and agent reviews (`git diff -- . ':(exclude,attr:linguist-generated=true)'`) leave it out. The OpenAPI snapshot (`apps/cloudflare-worker/test/__snapshots__/openapi.json`) is one; regenerate it with `pnpm --filter '@resend-challenge/cloudflare-worker' test -u` rather than editing it.
- Clients of the API use the typed client `ApiClient` from `libs/api.client`, with its methods grouped by resource (`client.drafts`, `client.revisions`); it keeps and resends the read bookmark and throws `ApiError` (code, message, request id and extras, no HTTP status) for error responses. Code using the client compares codes with the client's `ERROR_CODE`; the one in `api.routes` loads the contract's runtime.
- The README's [Human steps](README.md#human-steps) are the deploy procedure; `pnpm secrets:generate` belongs to them, since it sets a production secret.
- Never deploy or touch real Cloudflare or Resend resources (`wrangler deploy`, `wrangler login`, `wrangler secret put`, `wrangler d1 migrations apply --remote`, `pnpm secrets:generate`, `terraform init` with the real backend, `terraform apply`) unless the repository owner asks.

## Package instructions

- [`apps/cloudflare-worker/AGENTS.md`](apps/cloudflare-worker/AGENTS.md): integration tests (`useWorker()`, the test entry point's RPC methods, Send pipeline helpers, the Resend stub) and the Wrangler configs.
- [`libs/email-drafts/AGENTS.md`](libs/email-drafts/AGENTS.md): the folder layout, race tests with the holding D1 double, the Send Queue doubles, large fixtures, partial indexes, D1 `batch()` with Drizzle and migrations.
- [`libs/api.server/AGENTS.md`](libs/api.server/AGENTS.md): the `agents` and MCP SDK catalog with its peer dependencies, and serving the Review UI.
- [`libs/mcp-server/AGENTS.md`](libs/mcp-server/AGENTS.md): how the MCP server is split between its tools and the `/mcp` endpoint, and how it is tested.
- [`apps/review-ui/AGENTS.md`](apps/review-ui/AGENTS.md): the SPA's stack, the verdict-error query freeze, the CSP, the build under `/app` and the unit tests.
- [`qa/e2e/AGENTS.md`](qa/e2e/AGENTS.md): Playwright in Docker, the `reviewEnvironment` fixture and the screenshot baselines.
- [`apps/cli/AGENTS.md`](apps/cli/AGENTS.md): the CLI's process tests and the production constants that must match `wrangler.jsonc`.
- [`terraform/AGENTS.md`](terraform/AGENTS.md): what Terraform manages and the checks to run after changing it.
