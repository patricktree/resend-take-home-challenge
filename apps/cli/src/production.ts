/*
 * The production default, so an Agent with the Agent token reaches production without passing an
 * API URL. `test/production.test.ts` checks it against `apps/cloudflare-worker/wrangler.jsonc`.
 */

/** The production Worker's `PUBLIC_BASE_URL`. */
export const PRODUCTION_API_URL = "https://resend-challenge.patricktree.me";
