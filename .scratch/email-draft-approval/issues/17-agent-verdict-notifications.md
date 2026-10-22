# Notifying Agents of a verdict

Type: research
Status: resolved
Blocked by: 04, 15

## Question

Can an Agent learn of an Approval or Rejection as it happens, instead of polling `get_draft`? In particular, do MCP notifications allow it, now that core MCP 2026-07-28 has `subscriptions/listen`, and what would it take on a stateless `createMcpHandler` in a Worker?

## Comments

- From [04](04-mcp-on-cloudflare-and-mcp-apps.md): MCP 2026-07-28 is stateless, with `subscriptions/listen` replacing the HTTP GET stream; `/mcp` uses the stateless `createMcpHandler` with no Durable Object.
- From [15](15-spec-assembly.md): the server instructions and the Agent Skill tell the Agent to poll `get_draft`, and `tools/list` returns exactly six tools.

## Answer

Explored with the repository owner on 2026-10-22. **v1 keeps polling `get_draft` as the contract**; push notifications become a Future increment. Polling works with every MCP client, the CLI and the HTTP API, while a notification only helps where the host acts on it.

### Options, from most push-like to least

1. **`subscriptions/listen` on a Draft resource (preferred push).** Add a resource template `draft://{draftId}` whose `resources/read` returns the `get_draft` view, and advertise `resources.subscribe`. The Agent opens `subscriptions/listen` with `resourceSubscriptions: ["draft://…"]` and gets `notifications/resources/updated` when the Draft's `reviewStatus` or `sending` changes. No session or `McpAgent` is needed.
2. **A long-polling `wait_for_verdict` tool.** Works on the current handler and with any client, but its wait is capped by client tool timeouts and it blocks the Agent's turn.
3. **MCP Tasks.** Still polling underneath, experimental, with little client support.
4. **Webhooks to an Agent-supplied URL.** Only for Agents running on a server.

### What option 1 takes

- **A cross-isolate event bus.** The SDK's default `InMemoryServerEventBus` is per isolate, but the verdict request and the open listen stream usually run in different isolates. Either:
  - a `ServerEventBus` that polls D1 for the subscribed Drafts every 1 to 2 s inside the stream and publishes `resource_updated` on a change (no change to the verdict or Send paths; preferred first), or
  - a Durable Object hub (one, or one per Draft) that holds the listeners and that the verdict and Send paths notify after their commit (true push, but a new binding, Terraform and Wrangler config, and tests).
- **Keepalive.** An SSE comment every ~30 s so an idle stream is not closed; the client reconnects when the stream ends without a `complete` result.
- **Possibly a different handler.** `agents@0.28.1` may not serve `subscriptions/listen`; `/mcp` might move to the SDK's own `createMcpHandler`.

### Why not now

- The notification reaches the MCP client, not the model. Most hosts do not start a turn on `notifications/resources/updated`, and many do not speak 2026-07-28 yet. Only Claude Code's channels (experimental) can wake a session from a server event.
- It widens `/mcp` beyond six tools (a resource and a capability), changes the server instructions and the Agent Skill, and needs a listen-then-approve `/mcp` test, for a benefit few hosts can use today.

### For the spec

- [Future increments](../spec.md#16-future-increments): notifying Agents of a verdict through MCP `subscriptions/listen`.

[findings](../research/agent-verdict-notifications.md)
