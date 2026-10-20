# Email Draft Approval

A gate between Agents that compose emails and the human Reviewer who must approve each email before it is sent through Resend. One Cloudflare Worker serves the HTTP API, the MCP server and the Review UI. See the [spec](.scratch/email-draft-approval/spec.md) for the design and [GLOSSARY.md](GLOSSARY.md) for the terms.

The published OpenAPI document is served at `/api/openapi.json`.

## Development

See [AGENTS.md](AGENTS.md) for setup, commands and conventions.
