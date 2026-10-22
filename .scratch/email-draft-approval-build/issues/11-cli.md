# 11: CLI

**What to build:** Anyone runs `pnpm resend-challenge drafts …` from a checkout and works as an Agent against production with no setup. Spec: [CLI](../../email-draft-approval/spec.md#cli), [CLI process tests](../../email-draft-approval/spec.md#cli-process-tests).

**Blocked by:** 05 (List Drafts)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/8>)

- [x] Commander CLI with `drafts create | get | list | revise | submit | revision` and the spec's options; no verdict command anywhere
- [x] Token from `RESEND_CHALLENGE_TOKEN` (it first fell back to the committed Agent token; later changed: the Agent token became a Worker secret too, so the variable is now required); URL from `--api-url`, `RESEND_CHALLENGE_API_URL`, then the built-in production URL; HTTPS required except on loopback
- [x] Human output by default, `--json` prints one JSON value; errors as `{ error: { code, message } }` on stderr with exit 1; input validated with the contract's schemas before any request; tokens never printed
- [x] `--help` on root and every command; root help links the OpenAPI document
- [x] Process tests spawning the real CLI against a `node:http` API stub, covering everything in the spec's CLI process tests list
