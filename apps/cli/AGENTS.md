# Agent CLI

- The Agent CLI runs as `pnpm resend-challenge …` from the repository root.
- Its process tests in `test/` spawn the real CLI against a `node:http` API stub (`useApiStub()` in `test/api-stub.ts`) and pass it its whole environment, so `RESEND_CHALLENGE_TOKEN` and `RESEND_CHALLENGE_API_URL` never leak in. `runCli()` sets `RESEND_CHALLENGE_TOKEN` to a test token unless a test overrides it, or unsets it with `undefined`.
- `RESEND_CHALLENGE_TOKEN` is required: the Agent token is a Worker secret that is never committed, so the CLI has no fallback token. Its production URL in `src/production.ts` must equal `PUBLIC_BASE_URL` in `apps/cloudflare-worker/wrangler.jsonc`.
