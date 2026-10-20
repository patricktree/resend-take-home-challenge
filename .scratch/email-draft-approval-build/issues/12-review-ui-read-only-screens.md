# 12: Review UI: read-only screens

**What to build:** The Reviewer opens the deployed Review UI, enters the Reviewer token, browses the Pending and Decided lists and reads any Draft, including via an Agent's `reviewUrl` deep link. No verdicts yet. Spec: [Review UI](../../email-draft-approval/spec.md#11-review-ui), [Browser hardening](../../email-draft-approval/spec.md#browser-hardening), [e2e](../../email-draft-approval/spec.md#e2e).

**Blocked by:** 05 (List Drafts), 06 (Approve and reject)

**Status:** ready-for-agent

- [ ] React 19 SPA with TanStack Router and Query under `/app` (Vite `base`, router `basepath`), served via `env.ASSETS` with SPA fallback and the security headers; global styles shipped as an emitted stylesheet (no inline `<style>`), cup's black-and-white look
- [ ] Token screen rendered in place of the requested route, `agent_` tokens refused client-side, token in `localStorage`, any 401 clears it with "The token was not accepted.", Sign out
- [ ] Pending and Decided tables with the spec's columns, "Load more" paging, empty states, refetch on focus only
- [ ] Draft page: loading, "Draft not found.", other errors with `requestId`; recipients, revision, review status, escaped `pre-wrap` body, earlier-Rejection line; Unsubmitted shows "Not submitted for review yet."; Decided shows the verdict line
- [ ] Integration test for `/app` headers and SPA fallback
- [ ] e2e setup: Playwright in cup's Docker image, own `wrangler dev` per test with OS-assigned port and temporary persistence, Resend stub in the fixture, Agent moves through the typed client; role-based locators, no retries
- [ ] e2e: token-screen cases, deep link, Sign out, lists and paging, Unsubmitted and unknown Draft, no CSP violation on `/app/`
