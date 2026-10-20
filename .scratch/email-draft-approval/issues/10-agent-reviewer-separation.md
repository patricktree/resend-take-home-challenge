# Keeping Agent and Reviewer apart

Type: grilling
Status: resolved
Blocked by: 08, 09

## Question

How is it enforced that an Agent can never approve a Draft or trigger a Send without an Approval? Settle: credentials for Agents and for the Reviewer (preconfigured), how the server tells them apart so that the two verdict routes of the single API (see [09](09-api-surface.md)) accept only the Reviewer credential, how the MCP server authenticates to the API, and how the Reviewer's session is protected (CSRF, origin checks). Write the 'Demo simplifications' entries for authentication and authorization.

## Comments

- From [06](06-approval-binding.md): several humans share the single preconfigured Reviewer identity, so verdicts are not attributed to a person; include that in the authentication Demo simplifications entry.
- From [08](08-reviewer-surface.md): the Review UI (a deployed React SPA) is the only human interface and the only place a verdict can be rendered; no Reviewer CLI, no MCP App, no elicitation. Threat model is a credential boundary: no Agent credential can render a verdict, and the Reviewer credential is never given to an Agent; no verdict command exists in any CLI, so a Reviewer credential never sits in a CLI config or env var. Demo simplifications entry: an Agent running as the Reviewer's OS user, able to drive their browser or read their files, is not defended against; a real deployment adds per-verdict passkey confirmation (WebAuthn user verification over a challenge bound to Draft, Revision and verdict) and isolates Agents from the Reviewer's OS account.
- From [09](09-api-surface.md): there is one API and one contract, not separate Agent and Reviewer APIs. Every route accepts both Agent credentials and the Reviewer credential except `POST /api/v1/drafts/{draftId}/revisions/{revisionId}/approval` and `/rejection`, which are Reviewer-only (OpenAPI security scheme `reviewerAuth`; an Agent credential gets 403 `REVIEWER_ONLY`, an unauthenticated call 401 `UNAUTHENTICATED`). The MCP server and CLI never expose the verdict routes. The OpenAPI document at `GET /api/openapi.json` is served without authentication. Drafts are not scoped per Agent, which assumes one shared Agent credential; if this ticket chooses per-Agent credentials, revisit scoping.

## Answer

Resolved by grilling with Patrick on 2026-10-20.

### Credentials

- Two preconfigured bearer tokens, both sent as `Authorization: Bearer …`:
  - **Agent token**: one token shared by every Agent (REST API, CLI and MCP server).
  - **Reviewer token**: one token for the Review UI.
- Both are random 256-bit values with a readable prefix, `agent_…` and `reviewer_…`. The prefix makes a leaked token recognisable and lets the Review UI reject an Agent token before sending any request. It is only a hint: authorization never looks at it.
- Production secrets are the Worker secrets `AGENT_TOKEN` and `REVIEWER_TOKEN`, each holding exactly one value. How they are set and handed to evaluators is [11](11-cloudflare-app-structure.md)'s call.
- Brute force is not realistic at 256 bits, so there is no rate limiting on authentication. Tokens are never logged; logs record only the resolved role.
- Rejected alternatives:
  - several named Agent tokens (deferred, together with per-Agent scoping);
  - OAuth for Agents;
  - a Reviewer password login with a server session cookie;
  - Cloudflare Access in front of the Review UI (evaluators would need allow-listed emails, which conflicts with 08's "reachable without setup");
  - hard-coding the Reviewer token into the SPA bundle. The bundle is public, and any Agent could fetch it from the `reviewUrl` and read the token. That breaks the functional requirement, not just a hardening measure.

### How the server tells them apart

- One auth middleware takes the bearer, compares its SHA-256 digest in constant time against the digests of both configured secrets, and sets `role: AGENT | REVIEWER` on the request context. The role comes only from which secret matched, never from anything the client claims.
- A missing or unknown token gets 401 `UNAUTHENTICATED`, with no hint about which kind of token was expected. Only `GET /api/openapi.json` and the SPA's static files are public.
- Approval and Rejection run a `requireReviewer` guard before any database access. An Agent token gets 403 `REVIEWER_ONLY`. Every other REST route accepts both roles ([09](09-api-surface.md)).
- OpenAPI declares two `http bearer` schemes, `agentAuth` and `reviewerAuth`. The verdict routes list only `reviewerAuth`; every other route lists both.
- Tests (integration level):
  - the Agent token on both verdict routes gets 403, and the Draft stays `PENDING` with sending `NOT_SENT`;
  - a route-table test asserts that exactly those two routes are Reviewer-only;
  - the MCP `tools/list` contains no verdict tool.

### MCP server

- MCP clients send the Agent token as a static `Authorization` header to `/mcp`. The MCP server calls the API through the typed client with that same token. It has no credential of its own, so it can never be more privileged than the Agent calling it.
- `/mcp` accepts only the Agent token. The Reviewer token gets 403 `AGENT_ONLY`, so it is useless when configured into an Agent host. This adds an error code to 09's table, for `/mcp` only.
- No `workers-oauth-provider` in v1. Hosts that only accept OAuth connectors (for example claude.ai custom connectors) cannot connect.

### CLI

- Token from `DRAFT_APPROVAL_TOKEN`. The API URL comes from `--api-url`, then `DRAFT_APPROVAL_API_URL`, then the production URL built into the CLI as a constant, so a bare invocation talks to the deployed system. Like cup, the CLI requires HTTPS except on loopback.

### Local development and tests

- Fixed tokens `LOCAL_AGENT_TOKEN` and `LOCAL_REVIEWER_TOKEN` are exported from the routes package (as cup's `LOCAL_OPERATOR_ACCESS_TOKEN`). They are accepted only when the Worker runs with a local-environment flag.

### Review UI session

- The SPA shows a one-field "Reviewer token" screen. It rejects a token with the `agent_` prefix ("this is an Agent token"), stores the token in `localStorage` and sends it as a bearer. `localStorage` rather than `sessionStorage`, because every `reviewUrl` opens a new tab; it is no weaker against the threats in scope (XSS reads both, and disk access is 08's out-of-scope case).
- A visible "Sign out" clears the token. A 401 also clears it and returns to the token screen.

### Browser hardening

- CSRF does not apply: nothing authenticates through cookies, and the API sets none.
- The SPA and the API are served from the same origin (a constraint on [11](11-cloudflare-app-structure.md)). The API sends no CORS headers, so other origins cannot read responses.
- Content-Security-Policy `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` on the SPA. `frame-ancestors 'none'` keeps any page from framing the Approve button.
- Draft subject and body render only as React-escaped text, never as HTML.
- `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

### Rotation

- Rotating a token means redeploying a new secret; the old one stops working immediately. There is no overlap window and no expiry (Demo simplification).

### For the spec

- Demo simplifications:
  - **Single shared Reviewer token**: one preconfigured Reviewer token, pasted into the Review UI and kept in `localStorage`. Several humans share it, so verdicts are not attributed to a person. _Real deployment:_ Reviewers sign in through the organisation's IdP via OpenID Connect (SSO), each person with their own identity and a Reviewer role. The server keeps its own session in an `HttpOnly` cookie, with CSRF and origin checks, and the audit trail names who decided.
  - **Single shared Agent token**: every Agent uses the same token, and Drafts are not scoped per Agent (replaces 09's entry). _Real deployment:_ one credential per Agent, recorded as the Draft's creator, with reads and writes scoped to it.
  - **Static, non-expiring tokens**: rotation means redeploying a new secret, and the old token dies immediately with no overlap. _Real deployment:_ an OAuth 2.1 authorization server issues each Agent short-lived access tokens (authorization code + PKCE for interactive hosts, client credentials for headless Agents), with overlap during rotation and revocation.
  - **Static bearer for MCP**: `/mcp` takes the Agent token as a static header, so OAuth-only hosts cannot connect. _Real deployment:_ the same OAuth 2.1 authorization server in front of `/mcp` (`workers-oauth-provider`).
  - 08's entry about an Agent running as the Reviewer's OS user stays unchanged. The Reviewer token in `localStorage` falls under it.
- Future increments: OAuth 2.1 for `/mcp` via `workers-oauth-provider`, so OAuth-only MCP hosts can connect.
