# Agent CLI

- The Agent CLI runs as `pnpm resend-challenge …` from the repository root.
- Its process tests in `test/` spawn the real CLI against a `node:http` API stub (`useApiStub()` in `test/api-stub.ts`) and pass it its whole environment, so `RESEND_CHALLENGE_TOKEN` and `RESEND_CHALLENGE_API_URL` never leak in.
- Its fallback token `PUBLIC_AGENT_TOKEN` and production URL in `src/production.ts` must equal `AGENT_TOKEN` and `PUBLIC_BASE_URL` in `apps/cloudflare-worker/wrangler.jsonc`; `pnpm secrets:generate` rewrites the token in `wrangler.jsonc`, `src/production.ts` and every occurrence in `README.md`, and refuses to run when the README or `production.ts` does not hold the current token.
