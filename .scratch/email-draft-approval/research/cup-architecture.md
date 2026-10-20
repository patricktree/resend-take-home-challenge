# How cup is built

Source: local checkout `~/workspace/cup` (remote `https://github.com/patricktree/cup`, HEAD `e60a882`, read on 2026-10-20). All paths below are relative to that repo root. Versions are the specifiers in `package.json` / `pnpm-workspace.yaml` catalogs, with the installed version from `node_modules/.pnpm` in parentheses where it differs or matters.

## Summary

- pnpm monorepo with Turborepo; workspaces `apps/*`, `libs/*`, `qa/*`, `tooling/*`, plus selected packages from the `.patricktree-stack` Git submodule (`pnpm-workspace.yaml`, `.gitmodules`).
- HTTP API is **code-first**: routes and schemas are written in TypeScript with `@hono/zod-openapi` (`createRoute` + `OpenAPIHono` + Zod 4). The OpenAPI JSON is *exported* from the code at build time, not authored by hand.
- The typed client is **not generated from OpenAPI**. It is Hono RPC (`hc` from `hono/client`), with types inferred from the route definitions, wrapped in a small hand-written class per API.
- There is **no MCP server** in cup. There is one CLI, `apps/operator`, built with `commander` + `@commander-js/extra-typings` on top of the operator API client.
- Deployment target is a single Cloudflare Worker (`apps/cloudflare-worker`) that serves the API and the SPA assets, with Durable Objects (SQLite, Drizzle), Workflows, R2, Workers AI, Browser Rendering. Deployed manually with `wrangler deploy`; there are no CI workflow files in the repo.

## Monorepo layout and package boundaries

Root manifest `package.json`: `packageManager: pnpm@12.11.2`, `engines.pnpm: 12.11.2`, `devEngines.runtime: node ^24.21.0` (with `onFail: download`), `"type": "module"`. Root scripts delegate to Turbo tasks named `turbo:build`, `turbo:lint`, `turbo:test`, `turbo:cf-typegen`.

`pnpm-workspace.yaml` defines a default `catalog` (TypeScript, Vitest, Vite, Wrangler, oxlint/oxfmt, Playwright, `@types/node`) plus named catalogs `hono` (`@hono/zod-openapi ^1.6.3`, `hono ^4.13.13`) and `web-app` (React 19, `@cloudflare/vite-plugin 1.62.2`, TanStack Router plugin, wyw-in-js). Strict peer handling (`strictPeerDependencies: true`, `autoInstallPeers: false`), `engineStrict: true`, and an `allowBuilds` allow-list for native postinstall scripts. Wrangler is held at `~4.144.0` with a comment explaining a regression in newer workerd/miniflare.

Packages (all `@cup/*`, all `private: true`):

| Folder | Package | Role |
| --- | --- | --- |
| `apps/cloudflare-worker` | `@cup/cloudflare-worker` | Deployable Worker: `src/index.ts` is `export default createApiServer()` plus re-exports of Durable Object and Workflow classes |
| `apps/web-app` | `@cup/web-app` | React SPA (TanStack Router/Query, XState), uses `@cup/listener-api.client` (`src/api-client.ts`) |
| `apps/mobile-app` | — | Capacitor wrapper (Android/iOS native code) |
| `apps/operator` | `@cup/operator` | Operator CLI (`src/cli.ts`) |
| `libs/listener-api.routes` | `@cup/listener-api.routes` | Listener (public) API contract: Zod schemas (`src/contracts.ts`) and route definitions (`src/hono-app.ts`) |
| `libs/listener-api.client` | `@cup/listener-api.client` | Typed client for the listener API; also exports the OpenAPI JSON |
| `libs/operator-api.routes` | `@cup/operator-api.routes` | Operator API contract (same pattern) |
| `libs/operator-api.client` | `@cup/operator-api.client` | Typed client for the operator API |
| `libs/api-rpc.client` | `@cup/api-rpc.client` | Shared client helpers: `parseOkResponse`, `RpcError`, `trimTrailingSlash` |
| `libs/api-server` | `@cup/api-server` | Server composition: a `Hono` app with middleware that mounts both route apps with real handlers (`src/api-server.ts`), plus use cases under `src/use-cases/` |
| `libs/accounts`, `libs/conversion-grants`, `libs/registry` | | Domain owners implemented as SQLite-backed Durable Objects with Drizzle migrations (`drizzle/` folders) |
| `libs/conversion-contracts` | | Runtime-independent shared schemas and types |
| other `libs/*` | | Domain logic (workflow, narration, encoding, rate limits) |
| `qa/e2e` | `@cup/e2e` | Playwright E2E and Vitest system tests |
| `tooling/*` | | Repo tooling: `prepare-declaration-build`, `env-setup`, `docs-search`, `drizzle-migrations`, `brand-assets`, `config-oxlint` |

`docs/architecture/README.md` states the libraries are "code boundaries inside the deployed system, not separate network services"; Durable Object RPC and Workflow invocation are internal interfaces, and only the listener and operator APIs are HTTP.

Package shape convention (e.g. `libs/listener-api.routes/package.json`): `exports["."]` maps `types` to `./dist/types/index.d.ts` and `default` to `./src/index.ts` (consumers run TypeScript source, type-check against emitted declarations); internal imports use the `#src/*` subpath import; a checked-in `src/package.json` provides a separate package scope. `docs/declaration-builds.md` and `tooling/prepare-declaration-build` explain and implement this (the CLI cleans `dist/types` and mirrors `src/package.json` before `tsc --build`).

Dependency direction for an API: `*-api.routes` (contract, depends on `@hono/zod-openapi`, `hono`, `zod`) ← `*-api.client` (depends on routes + `api-rpc.client` + `hono`) ← consumers (`web-app`, `operator`). `api-server` depends on the routes packages, not on the clients.

## HTTP API and OpenAPI

Approach: code-first with `@hono/zod-openapi` `^1.6.3` (installed 1.6.3), `hono` `^4.13.13`, `zod` `^4.6.5`. Transitively this pulls `@asteasolutions/zod-to-openapi` 9.1.0 and `openapi3-ts` 4.6.1.

How a contract package is built (`libs/listener-api.routes/src/hono-app.ts`, mirrored in `libs/operator-api.routes/src/hono-app.ts`):

- Each endpoint is a `createRoute({ method, path, request: { params, query, headers, body }, responses: {...} })` object. Response maps list every status code with a description; error responses share one `errorResponseSchema` via an `errorResponse(description)` helper.
- A factory `createListenerApi(handlers)` builds `new OpenAPIHono({ defaultHook })` and chains `.openapi(route, handlers.x)` for every route. The handler map type `ListenerApiHandlers<Bindings>` is derived from the route objects, so server handlers are type-checked against the contract.
- `defaultHook` turns Zod validation failures into a `400` JSON body `{ error: { code: "invalid-input", message, requestId } }`.
- `createListenerContractApp()` calls the factory with handlers that throw; it exists only for OpenAPI export and for type inference of the client.
- `src/hono-client.ts` exports `type ListenerApiApp = ReturnType<typeof createListenerContractApp>` and `type ListenerApiClient = ReturnType<typeof hc<ListenerApiApp>>` (following Hono's "compile your code before using it" RPC guidance).
- Schemas live in `src/contracts.ts`; they reuse and rebuild shapes from domain libs. ADR `docs/adr/0010-tolerate-unknown-keys-at-the-listener-api.md` sets listener schemas as non-strict (drop unknown keys) while operator and internal schemas stay strict; `libs/api-server/test/strict-schema.ts` parses responses strictly in tests.

Server side (`libs/api-server/src/api-server.ts`): `createApiServer(dependencies)` builds a plain `Hono` app, adds middleware (cache headers, domain redirects, `bodyLimit` 4 KiB, `secureHeaders`, request IDs, error handler), then `.route("/", createListenerApi(listenerApiHandlers)).route("/", createOperatorApi(operatorApiHandlers))`. Handlers type their JSON with `satisfies` rather than parsing at runtime (`docs/architecture/README.md`).

OpenAPI export (`libs/listener-api.client/scripts/export-openapi-json.ts`): runs as part of `turbo:build` (`node ./scripts/export-openapi-json.ts && oxfmt ./dist/create-audiobook-from-url-openapi.json`), calls `app.getOpenAPIDocument({ openapi: "3.0.0", info: {...} })` and writes `dist/create-audiobook-from-url-openapi.json`. Only the listener API is exported; the operator API is not (`docs/architecture/README.md`). The document is a build artifact; nothing in the repo consumes it, and the app does not serve it at a route.

## Typed client

No code generation. `libs/listener-api.client/src/hono-client.ts` wraps `hc<ListenerApiApp>(baseUrl)` in a `hcWithType` indirection (comment cites TypeScript issue 47663) and exports `createHonoClient(baseUrl)`.

`src/rpc-client.ts` is a hand-written class (`ListenerApiClient`, plus `AuthenticatedRpcClient` for bearer-token calls; `libs/operator-api.client/src/rpc-client.ts` has `OperatorApiClient(baseUrl, accessToken)`). Each method calls a typed Hono path, e.g. `this.#honoClient.api.operator.grants[":grantId"].$get({ param }, this.#options(signal))`, and returns the raw `ClientResponse`. Auth headers and `AbortSignal` are injected via a private `#options()` helper.

Response handling is shared in `libs/api-rpc.client/src/rpc-response.ts`: callers wrap a call in `parseOkResponse(...)`, which uses Hono's `parseResponse` to return the inferred success body and throws `RpcError(code, message, status, retryAfter)` for any non-2xx, reading `{ error: { code, message } }` from the body and `Retry-After` (default 60 s). Depends on `type-fest ^5.10.0`.

## CLI

`apps/operator/src/cli.ts` (~400 lines, single file), run from source via Node type stripping: root script `"operator": "node apps/operator/src/cli.ts"`. Libraries: `commander ^15.0.0`, `@commander-js/extra-typings ^15.0.0`, `zod`.

- Command tree: `operator [--operator-url] [--json] [--debug] grant {create,list,inspect,set-allowance,revoke,invalidate-sessions,migrate}` and `account {list,inspect,adjust-allowance,deletions}`.
- Every action goes through `run(command, async (client, output) => ...)`, which resolves the base URL (`--operator-url` or `CREATE_AUDIOBOOK_FROM_URL_OPERATOR_URL`), enforces HTTPS except loopback, obtains a token, constructs `OperatorApiClient`, and centralizes error output.
- Inputs are validated with the contract's Zod schemas imported from `@cup/operator-api.routes` (e.g. `uuidV4Schema`, `adjustAccountAllowanceRequestSchema`); option choices come from exported constants (`accountPhases`, `projectedGrantStates`).
- Output: human-readable `Label: value` lines by default; `--json` writes one JSON value to stdout. Errors exit 1 and print `{ "error": { "code", "message" } }` (JSON mode) to stderr; API refusals keep the API's `code`, other failures map to `operator-error`. `--debug` prints a redacted cause.
- Idempotency: mutating commands accept `--request-id` (UUID), generated with `crypto.randomUUID()` if absent and printed so a retry can reuse it (`apps/operator/README.md`).
- Auth: production uses a Cloudflare Access JWT (env `CREATE_AUDIOBOOK_FROM_URL_ACCESS_TOKEN` or `cloudflared access token`); local development URLs use a fixed `LOCAL_OPERATOR_ACCESS_TOKEN` exported from the routes package. The server validates the `Cf-Access-Jwt-Assertion` with `jose` (`libs/api-server/src/api-server.ts`).
- Test: `apps/operator/test/operator-cli.test.ts` spawns the real CLI process against a local `node:http` stub server and asserts on stdout/stderr/exit code.

## MCP server

None. A search for `modelcontextprotocol`/`mcp` in tracked files finds no MCP server or SDK dependency.

## Tooling

- Package manager: pnpm 12.11.2 with catalogs; Corepack-style `packageManager` pin; `preinstall.sh` ensures the `.patricktree-stack` submodule is initialized; `postinstall.sh` runs env checks and Worker type generation.
- Task runner: Turborepo `^2.11.7`. Root `turbo.jsonc` defines tasks; packages extend `@patricktree-stack/config-turbo-typescript`, which caches `turbo:build` (`dist/**`, `*.tsbuildinfo`) and makes build/lint/test depend on `^turbo:build`. `apps/cloudflare-worker/wrangler.jsonc` is a global dependency because library Worker types are generated from it.
- TypeScript: `typescript` catalog is `npm:@typescript/typescript6@^6.0.2` (bin `tsc6`) and `@typescript/native` is `npm:typescript@^7.0.2` (bin `tsc`, the Go-native compiler); builds run `tsc --build`. Shared presets from `.patricktree-stack/tooling/config-typescript` (`tsconfig.defaults.json`: `module Node20`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`; plus `tsconfig.node24.json`, `tsconfig.cloudflare-workers.json`, `tsconfig.vitest.json`, type-stripping preset with `allowImportingTsExtensions`). Each package has `tsconfig.json` referencing `tsconfig.build.json` (src, declaration-only) and `tsconfig.tests.json`. Code runs as `.ts` directly via Node type stripping; only declarations are emitted.
- Worker types: `wrangler types` generates `worker-configuration.d.ts` per package (not committed), via `turbo:cf-typegen`.
- Lint: oxlint `^1.87.0` with `oxlint-tsgolint` for type-aware rules, run as `oxlint --type-aware --max-warnings 0 .`; config from `tooling/config-oxlint/oxlint-base.js` extending `@patricktree-stack/config-oxlint`; root `oxlint.config.ts` exists for the VS Code extension.
- Format: oxfmt `^0.72.0` (`oxfmt.config.ts`, `pnpm format` / `format:check`).
- Other checks: Knip `^6.41.0` (`knip.ts`, "declutter"), markdownlint-cli2 with relative-link rule, Mermaid check, zizmor via `uvx`, submodule pointer check.
- Tests: Vitest `^4.1.11` with `@vitest/coverage-v8`; per-package `vitest.config.ts` re-exports `@patricktree-stack/config-vitest/vitest-base.js` (`isolate: false`, v8 coverage). Durable Object integration tests use Wrangler's `createTestHarness` with a per-library `wrangler.test.jsonc` and a `test/worker.ts` entry (e.g. `libs/registry/test/durable-objects.test.ts`), getting real bindings via `worker.getEnv()` and inspecting storage via `worker.getDurableObjectStorage(...)`. API route tests call `createApiServer()` directly (`libs/api-server/test/*.test.ts`). E2E: Playwright `1.64.0` run inside the `mcr.microsoft.com/playwright:v1.64.0-noble` Docker image via `@patricktree-stack/config-playwright` (`qa/e2e/playwright.config.ts`), with mobile and desktop Chromium projects and screenshot baselines. AGENTS.md requires tests to use OS-assigned ports and never reuse existing servers.
- Git hooks (Husky `^9.1.7`): `pre-commit` runs `pnpm run validate:fast`; `pre-push` runs the submodule check and, when pushing `main`, `validate:extended`.
- Validation tiers (root `package.json`, `AGENTS.md`): `validate:fast` (env, submodule, format, docs, build/lint/test) and `validate:extended` (knip, brand assets, zizmor, both E2E suites).
- Docs: `docs/GLOSSARY.md`, `docs/adr/`, `docs/architecture/`, `docs/research/`, with a local docs search tool (`tooling/docs-search`).

## Deployment

- One Worker, `apps/cloudflare-worker/wrangler.jsonc` (`name: create-audiobook-from-url`, `main: src/index.ts`, `compatibility_flags: ["nodejs_compat"]`, `compatibility_date: 2026-08-18`, `workers_dev: false`, custom-domain routes for `cup.audio` and legacy hosts). Bindings: `ASSETS` (SPA, `run_worker_first: true`), Durable Objects `ACCOUNTS`, `CONVERSION_GRANTS`, `REGISTRY` with `new_sqlite_classes` migrations, two Workflows, R2 `AUDIO_BUCKET`, Workers AI, Browser Rendering. Observability logs and traces enabled at 100% sampling; `upload_source_maps: true`. Required secrets are declared under `secrets.required`, including `RESEND_API_KEY`.
- Build: `apps/cloudflare-worker/vite.config.ts` uses `@cloudflare/vite-plugin` (1.62.2); `vite build` bundles the Worker and copies the web app's `dist/web` as public assets (fails if the SPA was not built first). `vite` dev serves SPA and Worker together.
- Deploy: `pnpm --filter '@cup/cloudflare-worker' run deploy` = `pnpm run build && wrangler deploy`, run manually; `apps/cloudflare-worker/AGENTS.md` says to deploy only on explicit request. Secrets are set with Wrangler (`docs/production-configuration.md`). No `.github/workflows` exist in the repo.
- Infra outside the Worker: Terraform (`terraform/bootstrap`, `terraform/production`, GCS state) manages Supabase and the Resend sending domain (`terraform/production/resend.tf`: `resend_domain` for `cup.audio`, tracking off). Cloudflare DNS and Access stay outside Terraform.
- Operator API protection: Cloudflare Access application on path `/api/operator/*` only; the Worker re-validates the Access JWT (`apps/operator/README.md`).
- Resend usage: `libs/registry/src/deletion-coordinator.ts` calls `POST https://api.resend.com/emails` with plain `fetch` (no SDK), `Idempotency-Key` set to a stored notification key, a 10 s timeout, fixed `from: "Cup <no-reply@cup.audio>"`, `text` body; 4xx except 408/409/429 is final failure, other failures retry honoring `Retry-After`. Notification state is persisted in the Durable Object's SQLite via Drizzle.
