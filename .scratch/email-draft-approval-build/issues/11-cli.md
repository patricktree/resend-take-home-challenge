# 11: CLI

**What to build:** An evaluator runs `pnpm draft-approval drafts …` from a checkout and works as an Agent against production with no setup. Spec: [CLI](../../email-draft-approval/spec.md#cli), [CLI process tests](../../email-draft-approval/spec.md#cli-process-tests).

**Blocked by:** 05 (List Drafts)

**Status:** ready-for-agent

- [ ] Commander CLI with `drafts create | get | list | revise | submit | revision` and the spec's options; no verdict command anywhere
- [ ] Token from `DRAFT_APPROVAL_TOKEN`, falling back to the committed Agent token; URL from `--api-url`, `DRAFT_APPROVAL_API_URL`, then the built-in production URL; HTTPS required except on loopback
- [ ] Human output by default, `--json` prints one JSON value; errors as `{ error: { code, message } }` on stderr with exit 1; input validated with the contract's schemas before any request; tokens never printed
- [ ] `--help` on root and every command; root help links the OpenAPI document
- [ ] Process tests spawning the real CLI against a `node:http` API stub, covering everything in the spec's CLI process tests list
