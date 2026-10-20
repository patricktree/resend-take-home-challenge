# 01: Repository and Worker skeleton

**What to build:** A fresh monorepo in cup's layout with one Cloudflare Worker that authenticates every request and answers with the system's routing and error conventions. A developer can run it locally, call it with a local token and get the published (still route-less) OpenAPI document. Spec: [Architecture](../../email-draft-approval/spec.md#4-architecture), [Error model](../../email-draft-approval/spec.md#error-model), [Authentication and authorization](../../email-draft-approval/spec.md#7-authentication-and-authorization), [Integration test setup](../../email-draft-approval/spec.md#integration-test-setup).

**Blocked by:** None (can start immediately)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/1>)

- [x] pnpm + Turborepo monorepo with the packages from the spec's package table (empty where later tickets fill them), shared config from the `.patricktree-stack` submodule, oxlint, oxfmt, Knip, markdownlint, Vitest; no Git hooks
- [x] One Worker exporting `fetch` (plus stub `queue` and `scheduled`), routing as in the spec: `/` → 302 `/app/`, unknown `/api/…` and other paths → JSON 404 `NOT_FOUND`
- [x] Every response carries `X-Request-Id`; errors use the envelope with upper-snake-case codes; unhandled errors return 500 `INTERNAL_ERROR` with a generic message and `console.error` the root cause
- [x] Bearer middleware resolves `AGENT` / `REVIEWER` by constant-time digest comparison against `AGENT_TOKEN` and `REVIEWER_TOKEN`; missing or unknown token → 401 `UNAUTHENTICATED`; local tokens accepted only with `LOCAL_DEVELOPMENT === "true"` and a local host
- [x] `GET /api/openapi.json` is public, declares the `agentAuth` and `reviewerAuth` schemes, and is snapshot-tested
- [x] `useWorker()` integration fixture: one Worker instance per test in Wrangler's local test runtime, migrations applied inside workerd, empty storage per test
- [x] `pnpm dev` and `pnpm validate:fast` work; `.dev.vars.example` committed, `.dev.vars` gitignored
- [x] Integration tests cover routing, 401s, local-token refusal without the flag and on a non-local host, and `X-Request-Id`; unit test for token-to-role resolution
