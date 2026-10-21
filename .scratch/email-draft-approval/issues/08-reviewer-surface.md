# The Reviewer's surface: web UI vs agent-mediated or MCP Apps

Type: grilling
Status: resolved
Blocked by: 04

## Question

Does the Reviewer list, review, approve and reject Drafts in a dedicated web UI, through an agent host (e.g. MCP Apps rendered inside the agent's client), or both? The deciding question is trust: if a verdict reaches the server through an agent's host, how can the server tell a human verdict from an agent one, given the requirement that an agent must never be able to approve? Also weigh the accessibility requirement for the web UI.

## Answer

Resolved in a grilling session with the repository owner on 2026-10-20.

### Requirement, corrected

- The challenge asks for "a simple deployed and accessible interface where a human can review pending drafts and approve or reject them". It does not say "web UI"; [spec-input.md](../spec-input.md) now reads "the human interface is accessible".
- "Accessible" means reachable: evaluators open it at a deployed URL with no local setup. No WCAG conformance level is required (the repository owner clarified it is not necessary).

### The human interface is the Review UI, and only it

- A deployed web UI on Cloudflare, the **Review UI** (glossary term), with its own Reviewer login separate from every Agent credential. It is the only place a verdict can be rendered.
- Not in v1:
  - no MCP App;
  - no URL-mode elicitation (it reaches whoever drives the Agent's host, not necessarily the Reviewer);
  - no email approve/reject links (they would land on a server-hosted page anyway);
  - no Reviewer notifications.
- Review is asynchronous: the Agent submits and later reads review status. Nothing waits for a verdict.
- An MCP App inside an agent host was rejected as the verdict channel. The server cannot tell a View click from an Agent call ([research](../research/mcp-on-cloudflare-and-mcp-apps.md)), and evaluators would need an MCP-Apps-capable host. It is feasible for a View to call our API itself with its own Reviewer login:
  - the View declares our origin in `_meta.ui.csp.connectDomains`;
  - the login happens in the system browser via `ui/open-link`, and the View polls our server for the token;
  - the Reviewer bearer token stays in the View's memory.

  This holds under the credential boundary only if the host delivers our View code unmodified, because the host fetches the `ui://` HTML and injects it into a sandbox origin it owns. That makes it a Future increment only, and it shapes nothing else in the design.

### What the Review UI shows

- A **Pending** list, a **Decided** list (Drafts whose latest Revision has a verdict, with review and sending status, newest first), and any Draft by id. A failed Send stays visible this way after the Reviewer has moved on.
- Unsubmitted Drafts are never shown to the Reviewer.
- Flows, screens and error messages are [ticket 12](12-review-ui.md)'s.

### Stack and look

- A React 19 SPA with TanStack Router and Query, following cup's `apps/web-app`. It calls the Reviewer endpoints through a typed client.
- Where it is served from is [ticket 11](11-cloudflare-app-structure.md)'s call; the Reviewer login is [ticket 10](10-agent-reviewer-separation.md)'s.
- Visual style follows cup's simple black-and-white look and button styles (`~/workspace/cup/apps/web-app/src/app/design-system/button.tsx`, `global-styles.ts`, `dialog.tsx`, `toast.tsx`).
- Text inputs and textareas do not copy cup's opinionated `design-system/input.tsx`; they get a simple style consistent with the buttons.

### Agent side

- Draft responses (and so the Submission response) carry a `reviewUrl` to that Draft's page in the Review UI, built from one configured public base URL. The link grants nothing without the Reviewer login. The field name is [ticket 09](09-api-surface.md)'s.
- A CLI, generated from the endpoints or hand-written, is an Agent tool. It never contains verdict commands, so a Reviewer credential never needs to sit in a CLI config or env var. Whether Agents may also list all Drafts or read Reviewer-side views is ticket 09's call; only the verdict operations (approve, reject) are certainly excluded.

### Threat model

- Credential boundary: an Agent is anything acting with an Agent credential. No Agent credential can render a verdict, and the Reviewer credential is never given to an Agent.
- Not defended in v1: an Agent running as the Reviewer's OS user that can drive their browser or read their files. Any credential stored on that machine is usable by such an Agent. The only server-verifiable defences are:
  - a human act per verdict: a passkey with user verification over a challenge bound to Draft, Revision and verdict;
  - or a second device.

  Both need credential enrolment, which is close to the out-of-scope account management. Isolating Agents from the Reviewer's OS account is deployment guidance.

### For the spec

- Demo simplifications: an Agent running as the Reviewer's OS user, able to drive their browser or read their files, is not defended against. A real deployment adds per-verdict passkey confirmation (WebAuthn user verification over a challenge bound to Draft, Revision and verdict) and runs Agents isolated from the Reviewer's OS account.
- Future increments:
  - per-verdict passkey confirmation;
  - notifying the Reviewer when a Draft becomes Pending;
  - an MCP App review view that signs the Reviewer in through our own login and calls the Reviewer API directly with that token, never through the host's MCP connection. It trusts the host to deliver the View code unmodified and never takes a verdict from host-supplied data.
