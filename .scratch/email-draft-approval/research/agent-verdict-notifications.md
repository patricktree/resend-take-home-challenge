# Notifying Agents of a verdict

Research for [issue 17](../issues/17-agent-verdict-notifications.md). Sources read on 2026-10-22.

## Context: how an Agent learns of a verdict today

- The MCP server `instructions` and the Agent Skill tell the Agent to poll `get_draft` every 10 to 30 s and to hand back to the user after about 15 minutes ([spec, section 10](../spec.md#10-agent-interfaces)).
- `/mcp` is the stateless `createMcpHandler` from `agents/mcp/server`, with no Durable Object; it serves exactly six tools and no resources.

## MCP `subscriptions/listen` (core spec 2026-07-28)

Source: [Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions).

- `subscriptions/listen` opens a long-lived notification stream from the server to the client. It replaces the former `resources/subscribe` RPC and the HTTP GET endpoint.
- The request carries a `notifications` filter: `toolsListChanged`, `promptsListChanged`, `resourcesListChanged` (booleans) and `resourceSubscriptions` (a list of resource URIs). The server must not send a notification type the client did not request.
- The server's first message must be `notifications/subscriptions/acknowledged`, carrying the subset of the filter it agreed to honor. Unsupported types are left out.
- Every message on the stream carries `io.modelcontextprotocol/subscriptionId` in `_meta`, equal to the JSON-RPC id of the `subscriptions/listen` request, so one client can hold several subscriptions.
- A resource change arrives as `notifications/resources/updated` with the `uri`; the client then reads the resource.
- Over HTTP the client ends a subscription by closing the SSE stream. A server ending it on its own (for example at shutdown) should first send a `subscriptions/listen` result with `resultType: "complete"`. A stream that closes without that result is a disconnect, and the client may reconnect.
- The server keeps no subscription state across connections. The protocol has no session, so a listen stream is one ordinary request and fits a stateless server.

## SDK support in the repository (checked in `node_modules`)

- `@modelcontextprotocol/server@2.3.1` serves `subscriptions/listen`. It honors `resourceSubscriptions` only when the server advertises `capabilities.resources.subscribe`.
- Change events go through a `ServerEventBus` interface; `InMemoryServerEventBus` is the default, and a `ServerNotifier` publishes them (`resourceUpdated(uri)`). The bus is in-process.
- `@modelcontextprotocol/client@2.3.1` has `client.listen()`; on a 2025-era connection it refuses and points to `resources/subscribe`.
- `agents@0.28.1` mentions the 2026-07-28 protocol only in its client code. Whether its `createMcpHandler` serves `subscriptions/listen`, or `/mcp` would have to move to the SDK's own `createMcpHandler`, is untested.

## Other mechanisms

- **Long-polling tool:** a `wait_for_verdict` tool that keeps the `tools/call` open until the Draft leaves `PENDING` or a timeout passes, sending `notifications/progress` while it waits, then returns the `get_draft` view. Works on the stateless handler today. Client tool timeouts (often about 60 s, configurable in Claude Code) cap the wait, and the Agent's turn is blocked meanwhile.
- **MCP Tasks** (spec 2025-11-25, experimental): a tool call returns a task that the client polls with `tasks/get`, with optional status notifications. Still polling, and few clients support it.
- **Webhooks:** the Agent passes a callback URL with `create_draft` or `submit_draft`, and the Worker POSTs the verdict to it. Suits Agents running on a server; useless for an Agent on a laptop.

## Open questions

- Which hosts speak 2026-07-28 and send `subscriptions/listen` at all.
- What a host does with `notifications/resources/updated`. A notification reaches the MCP client, not the model; most hosts at best refresh a cache and do not start a turn. Claude Code's channels (an experimental `claude/channel` capability, a research preview at the time of writing) let a server push an event that starts a turn, but only in Claude Code.
- How long Cloudflare keeps an idle streaming Worker response open; SSE comments every ~30 s are the usual guard.
