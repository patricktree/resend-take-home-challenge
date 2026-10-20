# How cup is built

Type: research
Status: resolved
Blocked by:

## Question

How is `~/workspace/cup` structured, so this project can follow it? Cover: monorepo layout and package boundaries; how the HTTP API and its OpenAPI description are defined (code-first vs spec-first, which libraries); how the typed TypeScript client or SDK is produced; how the MCP server and the CLI are built on the client; tooling (package manager, build, lint, format, test setup); anything specific to deployment. Report what it does, not recommendations.

## Answer

- pnpm 12 monorepo with Turborepo and pnpm catalogs; workspaces `apps/*`, `libs/*`, `qa/*`, `tooling/*` plus shared config from the `.patricktree-stack` submodule; Node 24 runs `.ts` directly via type stripping, `tsc --build` emits declarations only.
- Each HTTP API is split into a contract package `libs/<name>-api.routes` (Zod schemas + routes) and a client package `libs/<name>-api.client`; a shared `libs/api-rpc.client` holds `parseOkResponse` and `RpcError`; `libs/api-server` mounts the route apps with real handlers; `apps/cloudflare-worker` is a thin entry exporting the server and Durable Object classes.
- OpenAPI is code-first: `@hono/zod-openapi` ^1.6.3 (`createRoute` + `OpenAPIHono`), `hono` ^4.13.13, `zod` ^4.6.5; handler types are derived from the routes; a build script exports `dist/*-openapi.json` via `getOpenAPIDocument` (listener API only; nothing consumes it).
- The client is not generated: Hono RPC `hc<App>()` infers types from the contract app, wrapped in a small hand-written class whose methods return `ClientResponse`; callers use `parseOkResponse` to get the typed body or an `RpcError` with code, status and `Retry-After`.
- No MCP server exists in cup. The one CLI (`apps/operator`) uses `commander` ^15 with `@commander-js/extra-typings`, validates input with the contract's Zod schemas, has `--json` output, structured error codes, and `--request-id` idempotency keys.
- Tooling: oxlint (type-aware, `--max-warnings 0`), oxfmt, Knip, markdownlint, Husky hooks (`validate:fast` on commit, extended on push to main); Vitest 4 with Wrangler `createTestHarness` for Durable Object integration tests; Playwright 1.64 E2E in Docker.
- Deployment: one Worker (`wrangler.jsonc`, SQLite Durable Objects with Drizzle, Workflows, R2, assets served by the Worker), built with `@cloudflare/vite-plugin` and deployed manually with `wrangler deploy`; no CI workflows; Terraform manages Supabase and the Resend domain.
- Resend is already used directly via `fetch` with an `Idempotency-Key` and persisted notification state (`libs/registry/src/deletion-coordinator.ts`).

[findings](../research/cup-architecture.md)
