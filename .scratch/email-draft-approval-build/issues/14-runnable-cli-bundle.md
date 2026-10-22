# 14: Runnable CLI bundle

**What to build:** An Agent or evaluator in a fresh clone with nothing but Node 24 on the PATH runs `node apps/cli/bundle/resend-challenge.mjs drafts …`: no pnpm, no `pnpm install`, no build. Spec: [CLI](../../email-draft-approval/spec.md#cli), [CLI process tests](../../email-draft-approval/spec.md#cli-process-tests). Reasoning: [16 Runnable CLI bundle](../../email-draft-approval/issues/16-runnable-cli-bundle.md).

**Blocked by:** 11 (CLI)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/30>)

- [x] `apps/cli/rolldown.config.ts` bundles `src/cli.ts`, `libs/api.client`, `libs/api.routes` and all their npm dependencies into one ESM file, `apps/cli/bundle/resend-challenge.mjs`: `platform: "node"`, only `node:*` builtins external, target `node24`, not minified, legal comments kept, no source map, deterministic, `#!/usr/bin/env node` as its first line and committed with the executable bit
- [x] `rolldown` is a devDependency of `apps/cli`, on the catalog version that Vite resolves; `apps/cli/package.json` has no `bin` field
- [x] `turbo:build` of `apps/cli` writes the bundle after `tsc --build`; `bundle/**` is a build output and excluded from the build inputs, and a change in `libs/api.client` or `libs/api.routes` rebuilds it through `^turbo:build`
- [x] The CLI process tests spawn the bundle; `turbo:test` of `apps/cli` depends on its own `turbo:build`
- [x] The bundle is marked `linguist-generated=true` and left out of oxfmt, oxlint and Knip
- [x] `pnpm resend-challenge` stays on `src/cli.ts` as the development path
- [x] README, spec, `AGENTS.md` and `apps/cli/AGENTS.md` describe the bundle as the way Agents run the CLI
