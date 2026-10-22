/**
 * A Markdown file imports as its text: the Worker's Vite build loads it through the
 * `markdownAsText` plugin (apps/cloudflare-worker/vite.config.ts), and the runs that Wrangler
 * bundles through a `Text` module rule (apps/cloudflare-worker/test/wrangler.test.jsonc,
 * qa/e2e/wrangler.jsonc).
 */
declare module "*.md" {
  const text: string;
  export default text;
}
