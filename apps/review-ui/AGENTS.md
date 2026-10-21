# Review UI

- The Review UI is a React SPA with TanStack Router (code-based routes, `basepath: "/app"`) and TanStack Query (suspense queries), styled with cup's reset and base variables in `src/global.css` and Linaria. It calls the API only through `DraftApprovalClient` (`src/api-client.ts`) with the token stored in `localStorage`; any 401 clears the token and the query cache (`src/query-client.ts`).
- While a verdict error shows, the Draft page's query does not refetch on window focus or reconnect, so only "Reload Draft" replaces the Revision under it. [`qa/e2e/AGENTS.md`](../../qa/e2e/AGENTS.md) covers e2e tests that need stale data.
- Global styles stay in emitted stylesheets: the Content-Security-Policy blocks inline `<style>` and scripts.
- Vite builds the Review UI with `base: "/app/"` into `apps/review-ui/dist/web/app/`, and the Worker's Vite build ships `dist/web` as its static assets. `libs/api.server/src/review-ui.ts` serves `/app` from the `ASSETS` binding, falls back to `/app/index.html`, and sets the security headers. [`apps/cloudflare-worker/AGENTS.md`](../cloudflare-worker/AGENTS.md) covers the integration tests' fixture in place of the build and the dev server's CSP.
- The unit tests (`test/`, Vitest) cover the Review UI's pure functions, such as the sending-status labels.
