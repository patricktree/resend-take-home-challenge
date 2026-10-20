# 10: MCP server

**What to build:** An Agent connects an MCP host to `/mcp` with the Agent token, discovers six tools and can run the whole Agent side of the lifecycle; it never gets a verdict tool and cannot bypass the API's checks. Spec: [MCP server](../../email-draft-approval/spec.md#mcp-server), [MCP](../../email-draft-approval/spec.md#mcp).

**Blocked by:** 05 (List Drafts)

**Status:** done (https://github.com/patricktree/resend-take-home-challenge/pull/7)

- [x] Stateless `createMcpHandler` (MCP TypeScript SDK v2, Streamable HTTP, no Durable Object, no OAuth) mounted at `/mcp`
- [x] Six hand-written tools on the typed client (`create_draft`, `get_draft`, `list_drafts`, `revise_draft`, `submit_draft`, `get_revision`) with Zod input schemas from the contract, `outputSchema`, `structuredContent`, `readOnlyHint` on reads
- [x] The typed client calls the Hono app in-process with the caller's token; API errors become `isError` results with code, message and extras
- [x] Reviewer token on `/mcp` → 403 `AGENT_ONLY`
- [x] Server instructions describe the lifecycle, state that Agents cannot approve or send, and link the OpenAPI document
- [x] Integration tests with the official MCP SDK client: `tools/list` returns exactly six tools; one happy path per tool; a 409 as a tool error; `revise_draft` without `baseRevisionId` refused by its schema
