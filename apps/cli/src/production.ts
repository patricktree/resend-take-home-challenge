/*
 * The production defaults, so an evaluator acts as an Agent against production with no setup.
 * `test/production.test.ts` checks both against `apps/cloudflare-worker/wrangler.jsonc`.
 */

/** The production Worker's `PUBLIC_BASE_URL`. */
export const PRODUCTION_API_URL = "https://resend-challenge.patricktree.me";

/**
 * The public Agent token, the production Worker's `AGENT_TOKEN`. `pnpm secrets:generate` rewrites
 * it together with `wrangler.jsonc` and the README.
 */
export const PUBLIC_AGENT_TOKEN = "agent_placeholder-run-pnpm-secrets-generate";
