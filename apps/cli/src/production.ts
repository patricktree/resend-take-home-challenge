/*
 * The production defaults, so anyone acts as an Agent against production with no setup.
 * `test/production.test.ts` checks both against `apps/cloudflare-worker/wrangler.jsonc`.
 */

/** The production Worker's `PUBLIC_BASE_URL`. */
export const PRODUCTION_API_URL = "https://resend-challenge.patricktree.me";

/**
 * The public Agent token, the production Worker's `AGENT_TOKEN`. `pnpm secrets:generate`
 * (`tooling/secrets-generate`) rewrites it together with `wrangler.jsonc` and the README by finding
 * the exact text `PUBLIC_AGENT_TOKEN = "<token>";`, so keep the declaration on one line in this
 * form.
 */
export const PUBLIC_AGENT_TOKEN = "agent_-17WHltuc9F9_Lpa7Yl3yy_tJ5_Upo07v637L_y1330";
