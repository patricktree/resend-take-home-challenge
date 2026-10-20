# MCP on Cloudflare and MCP Apps

Research for [issue 04](../issues/04-mcp-on-cloudflare-and-mcp-apps.md). Sources read on 2026-10-20.

## Context: core MCP spec today

- The current core spec is **2026-07-28**; `https://modelcontextprotocol.io/specification/latest` redirects to it ([versioning](https://modelcontextprotocol.io/specification/versioning), [changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx)).
- It makes MCP **stateless**: no `initialize` handshake, no `Mcp-Session-Id`, protocol version and client capabilities travel in each request's `_meta`, plus a new `server/discover` RPC (SEP-2567, SEP-2575).
- Server-initiated requests (elicitation, sampling, roots) are replaced by **Multi Round-Trip Requests**: the server returns `resultType: "input_required"` and the client retries with `inputResponses` (SEP-2322).
- Sampling, Roots and Logging are deprecated (SEP-2577). The HTTP GET stream and SSE resumability are gone; `subscriptions/listen` replaces them.
- Streamable HTTP POSTs must carry `Mcp-Method` / `Mcp-Name` headers (SEP-2243).

## (a) Remote MCP server on Cloudflare Workers

### Transport and server API

- Streamable HTTP is the remote transport; SSE is deprecated and kept only for existing `McpAgent` deployments ([Transport](https://developers.cloudflare.com/agents/model-context-protocol/transport/)).
- **Recommended: `createMcpHandler(factory, options)`** from `agents/mcp/server` ([handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)):
  - Takes a factory that builds a fresh MCP TypeScript SDK **v2** `McpServer` per request; tools are registered with `server.registerTool(...)`.
  - Stateless: GET/DELETE return 405, no session ID. Elicitation works through MRTR (`input_required`); pushed elicitation/sampling/roots fail.
  - Options include `route` (default `/mcp`), `authContext`, `corsOptions` (default wildcard CORS), `allowedHostnames`, `allowedOriginHostnames`, `legacy`, `responseMode`. Create the handler at module scope if you use `subscriptions/listen` notifications.
  - **No Durable Object is required.** Cross-request state goes in a DO, D1, KV or R2 of your choosing.
  - The Agents changelog says the handler supports spec 2026-07-28 ([Agents changelog](https://developers.cloudflare.com/changelog/product/agents/)); latest `agents` release is 0.28.1 (2026-10-13, [releases](https://github.com/cloudflare/agents/releases)).
- `createLegacyMcpHandler` (with `WorkerTransport`) is a temporary bridge for servers that still need protocol sessions.
- **`McpAgent` is deprecated and feature-frozen**; the docs say not to build new `McpAgent` servers ([McpAgent](https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/), [handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)). It needs a Durable Object binding with a SQLite migration.
- For this project's "HTTP API → typed client → MCP server" design, a stateless `createMcpHandler` Worker whose tools call the typed client is the documented path. Draft state stays in our own storage, not in the MCP layer.

### Authorization

From [Cloudflare Authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/):

- **`@cloudflare/workers-oauth-provider`** (`OAuthProvider`) makes the Worker an OAuth 2.1 authorization server. Options are `apiRoute: "/mcp"`, `apiHandler: createMcpHandler(...)`, `defaultHandler` (your login/consent UI), `authorizeEndpoint`, `tokenEndpoint` and `clientRegistrationEndpoint` (Dynamic Client Registration).
- Login options:
  - A third-party IdP (GitHub, Google). The Worker then issues its own MCP token.
  - Cloudflare Access (SSO or one-time PIN).
  - A managed provider (Stytch, Auth0, WorkOS, Descope).
  - Your own `defaultHandler`.
- Tool handlers read app props via `getMcpAuthContext()`; verified token metadata is at `context.http.authInfo`. With `McpAgent` it was `this.props`.
- Client flow, as the page describes it:
  1. The MCP request returns 401.
  2. The client uses PKCE: it opens the browser to authorize, the user logs in and consents, and the client exchanges the code for an access token (and optionally a refresh token).
  3. The client sends a bearer token on each MCP request.
- Spec 2026-07-28 auth deltas: AS should send `iss` (RFC 9207), clients must validate it; DCR must carry `application_type`; credentials are bound to the issuing AS.
- Permission checks can live inside tool handlers, or tools can be registered conditionally so the model never sees them.
- **Unknown:** whether Claude/ChatGPT and other hosts accept a plain static bearer token (no OAuth) for a remote connector. The Cloudflare page does not cover no-auth or static-token setups. A demo could use OAuthProvider with a trivial `defaultHandler` that maps to the preconfigured identity.

## (b) MCP Apps (`io.modelcontextprotocol/ui`, SEP-1865)

### Status

- The spec is **Stable (2026-01-26)**, Extensions track; a `draft` revision also exists ([stable spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx), [overview](https://modelcontextprotocol.io/extensions/apps/overview)).
- The SDK is `@modelcontextprotocol/ext-apps` **v2.0.3** (2026-09-25), built on MCP TS SDK 2.0 ([releases](https://github.com/modelcontextprotocol/ext-apps/releases)). Its wire protocol is unchanged from 1.x.
- Scope is HTML only (`text/html;profile=mcp-app`) served as `ui://` resources. A tool links to its UI via `_meta.ui.resourceUri`; the flat `_meta["ui/resourceUri"]` is deprecated.

### How the UI calls tools

- The View (sandboxed iframe) is a JSON-RPC client over `postMessage` to the **host**. It sends standard `tools/call` (`app.callServerTool` / `client.callTool`), and the host forwards it to the MCP server over the host's existing connection.
- The draft spec says the host "MAY forward any message from the View ... MAY decide to block some messages or subject them to further user approval."
- Other View→host methods include `ui/message` (post into the chat, host MAY ask consent), `ui/update-model-context` and `ui/open-link`. Apps can also expose their own tools to the agent.
- Security mitigations: mandatory sandboxed iframe on a separate origin, CSP from declared `_meta.ui.csp` domains (host MUST block undeclared), and "auditable" JSON-RPC that the host SHOULD validate and log.

### App-only tool visibility

`_meta.ui.visibility: Array<"model" | "app">`, default `["model","app"]` (draft spec §Visibility):

- `["app"]` means the host **MUST NOT** put the tool in the agent's tool list.
- Hosts **MUST** reject `tools/call` from apps for tools without `"app"`.
- App-only tools are callable "from the same server connection only"; cross-server calls are always blocked.
- The spec suggests app-only tools for "refresh buttons, form submissions".
- This is **host-enforced metadata**. The server still exposes the tool on its MCP endpoint, and any client holding a valid token can call it.

### Host support

The [client matrix](https://modelcontextprotocol.io/extensions/client-matrix) is community-maintained. It lists MCP Apps support in:

- Claude (web)
- Claude Desktop
- VS Code GitHub Copilot
- Microsoft 365 Copilot
- Goose
- Postman
- MCPJam
- ChatGPT
- Cursor
- Archestra.AI
- PostHog Code

Claude Code (CLI) and MCP Inspector are not listed for MCP Apps.

### Trust: can the server tell a human-in-UI call from a model/host call?

**No, not by protocol.**

- A View's `tools/call` reaches the server as an ordinary `tools/call` on the host's connection with the host's OAuth token. Neither the stable nor the draft spec defines an origin marker, user-gesture proof or signature that tells it apart from an agent-initiated call.
- The only separation is `visibility`, which the host enforces and the server cannot verify.
- Spec 2026-07-28 adds per-request `clientInfo` in `_meta`, but that identifies the client software, is self-asserted, and says nothing about a human.
- Consequences:
  - Any MCP client can call an "app-only" tool directly. That includes a misbehaving host, a different client, or an agent with the user's token (e.g. a coding agent or script).
  - A malicious or compromised host could also fire it from the UI path without a click.
- The spec's own guidance treats tool approval as host policy: per-app-instance, per-server or per-tool approval, plus attribution and audit trails (draft spec, "Security implications"). It is not a server-verifiable guarantee.
- **Implication for this project:** an Approval must not rest on "the call came through the MCP App". Approval needs a channel where the server itself authenticates the human Reviewer and the Agent cannot act. Options:
  - a separate Reviewer web UI with its own session, outside the Agent's credentials;
  - MCP **URL-mode elicitation**, which sends the user to a server-hosted URL "that must not pass through the MCP client". The [elicitation spec](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/client/elicitation.mdx) says servers MUST bind elicitations to user identity and "MUST NOT rely on client-provided user identification without server verification".

  An MCP App can still serve as a convenience *view* (show the Revision, link out to the review page), not as the authority for verdicts.

## Unknowns

- No Cloudflare doc or example covers serving MCP Apps `ui://` resources from `createMcpHandler`. The only related guide is the older [ChatGPT app guide](https://developers.cloudflare.com/agents/guides/chatgpt-app), which uses `text/html+skybridge` and the pre-factory API. Whether `registerAppResource`/`registerAppTool` from `@modelcontextprotocol/ext-apps/server` work with the factory-per-request handler is untested, but likely, since they only register tools and resources on the SDK v2 server.
- Each host's actual approval UX for app-initiated tool calls (Claude, ChatGPT, etc.) is not documented in the spec.
- Whether ext-apps' stable 2026-01-26 spec has been formally re-based onto core 2026-07-28. The v2 SDK release says the wire protocol is unchanged.
- Host behaviour with static bearer tokens versus mandatory OAuth for remote connectors (see (a)).
