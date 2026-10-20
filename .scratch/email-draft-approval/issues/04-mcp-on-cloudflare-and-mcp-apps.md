# MCP on Cloudflare and MCP Apps

Type: research
Status: resolved
Blocked by: 

## Question

Two parts. (a) Hosting a remote MCP server on Cloudflare Workers: transports (Streamable HTTP), the Agents SDK / `McpAgent`, the workers OAuth provider, alternatives for a stateless MCP server, and how MCP clients authenticate. (b) MCP Apps (the MCP UI extension): current spec status; how an app UI calls tools; whether a tool can be hidden from the model and only callable by the UI ('app-only' visibility); which hosts support it today; and the trust question: can the server tell a call initiated by a human in the app UI apart from one made by the model or the agent host, or could an agent imitate it? Primary sources: modelcontextprotocol.io, the MCP Apps spec or SEP, Cloudflare docs.

## Answer

- Core MCP is now spec 2026-07-28. It is stateless: there is no `initialize` handshake and no `Mcp-Session-Id`, and multi-round-trip (`input_required`) requests replace server-initiated elicitation and sampling.
- On Workers, use the stateless `createMcpHandler(factory)` from `agents/mcp/server` with MCP TS SDK v2 over Streamable HTTP. It needs no Durable Object. `McpAgent` is deprecated and feature-frozen, and SSE is deprecated.
- For auth, `@cloudflare/workers-oauth-provider` wraps the handler (`apiRoute: "/mcp"`). It provides OAuth 2.1 with PKCE and Dynamic Client Registration, and a `defaultHandler` does the login (third-party IdP, Cloudflare Access, or a custom handler). Tools read identity via `getMcpAuthContext()`. Clients get a 401, run the browser OAuth flow, and then send a bearer token.
- MCP Apps (SEP-1865, `io.modelcontextprotocol/ui`) is Stable as of 2026-01-26, with a draft revision in progress. The SDK is `@modelcontextprotocol/ext-apps` v2.0.3. UIs are HTML `ui://` resources rendered in a sandboxed iframe.
- An App UI calls tools by sending standard `tools/call` to the host over `postMessage`. The host forwards it on its own MCP connection, using its own token. The host may block such calls or ask the user to approve them.
- `_meta.ui.visibility: ["app"]` hides a tool from the model. Hosts MUST NOT list it to the agent and MUST reject app calls to tools without `"app"`. The host enforces this, not the server.
- Hosts listed as supporting MCP Apps: Claude web and Desktop, ChatGPT, VS Code Copilot, M365 Copilot, Cursor, Goose, Postman, MCPJam, Archestra, and PostHog Code. Claude Code CLI is not listed.
- Trust: the server cannot tell a human click in the App from a call by the model, the host, or another client. The protocol has no origin or user-gesture marker, `clientInfo` is self-asserted, and an "app-only" tool is callable by anyone holding the token. An agent could imitate a UI call.
- Implication: verdicts (Approval and Rejection) must not be exposed as MCP tools reachable with the Agent's credentials. The Reviewer needs a separately authenticated channel, such as a review web UI or a URL-mode elicitation link to a server-hosted page. An MCP App is at most a convenience view.

[findings](../research/mcp-on-cloudflare-and-mcp-apps.md)
