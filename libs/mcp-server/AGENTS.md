# MCP server

- The MCP server lives in two places: `libs/mcp-server` holds the six tools on the typed client and `describeLifecycle`, the lifecycle text that the agent quickstart (`libs/http-app/src/agent-guide.ts`) shares, and `libs/http-app/src/mcp-endpoint.ts` mounts them at `/mcp` (stateless `createMcpHandler` from `agents/mcp/server`, Agent token only). Each request builds an `ApiClient` with the caller's token whose `fetch` calls the Hono app in-process, so tool calls pass the API's own checks. Tests drive `/mcp` with the official MCP SDK client (`apps/cloudflare-worker/test/mcp.test.ts`).
- [`libs/http-app/AGENTS.md`](../http-app/AGENTS.md) covers the `agents` and MCP SDK versions.
