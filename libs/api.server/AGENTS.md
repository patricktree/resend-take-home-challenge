# API server

- `src/mcp-endpoint.ts` mounts the tools of `libs/mcp-server` at `/mcp`; [`libs/mcp-server/AGENTS.md`](../mcp-server/AGENTS.md) describes the MCP layout and its tests.
- `agents` and the MCP SDK packages sit in the `mcp` catalog of `pnpm-workspace.yaml`: `agents` names exact versions of `@modelcontextprotocol/server` and `@modelcontextprotocol/client` as peer dependencies, so upgrade the three together. `libs/api.server` lists `@modelcontextprotocol/client`, `@modelcontextprotocol/server` and `zod` only to provide those peers (pnpm installs no peers on its own here); its code imports none of them.
- `src/review-ui.ts` serves the Review UI under `/app` and sets its security headers; [`apps/review-ui/AGENTS.md`](../../apps/review-ui/AGENTS.md) describes the build and the CSP.
