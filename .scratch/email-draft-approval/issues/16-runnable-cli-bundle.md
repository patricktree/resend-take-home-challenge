# Runnable CLI bundle

Type: grilling
Status: resolved
Blocked by: 15

## Question

How does an Agent or evaluator run the `resend-challenge` CLI from a fresh `git clone` with nothing but Node 24 on the PATH? Until now the CLI ran from a checkout as `pnpm resend-challenge …`, which needs pnpm and `pnpm install`. Node 24 already runs the CLI's TypeScript and the workspace libraries it imports (`libs/api.client`, `libs/api.routes`) through type stripping, so the only blocker is the npm dependencies: `commander`, `@commander-js/extra-typings`, `zod`, `hono` and `@hono/zod-openapi` (with `@asteasolutions/zod-to-openapi`).

## Comments

- From [15](15-spec-assembly.md): the CLI runs from a checkout, not from npm; publishing it is a Future increment.
- From [13](13-testing-strategy.md): there is no CI, and `pnpm validate:fast` is the gate before every commit.

## Answer

Decided with the repository owner on 2026-10-22. **Commit one bundled JavaScript file**, `apps/cli/bundle/resend-challenge.mjs`, that contains the CLI, the workspace libraries it imports and all their npm dependencies, generated from the sources by the package's `turbo:build`. Agents run it as `node apps/cli/bundle/resend-challenge.mjs …`.

### Why a committed bundle

- **Not vendoring `node_modules`:** pnpm's `node_modules` is a tree of symlinks into a store, holding every development dependency too; committing a resolvable subset of it is large, platform-sensitive and hard to keep in step with the lockfile.
- **Not dropping the dependencies:** the spec builds the CLI with `commander` and `@commander-js/extra-typings` and on the typed client, which uses `hono/client` and the contract's Zod schemas. Rewriting it without them would duplicate the contract and its validation.
- **Not publishing to npm:** out of scope for this change; it stays a Future increment ("a CLI published to npm"), and it could ship this same bundle.

### Why Rolldown directly

Vite's library mode targets the browser by default and externalizes dependencies for SSR builds, so both would need overriding to get one self-contained Node file. Rolldown with `platform: "node"` resolves Node conditions, keeps builtins as imports and inlines everything else. It is the bundler Vite 8 already uses, pinned in the catalog to the version Vite resolves, so the workspace installs one Rolldown.

### Why no drift check

A check such as `git diff --exit-code` after the build would only run locally, since there is no CI, and there it fails on the very change being committed, before the developer has staged the regenerated bundle. Instead, `turbo:build` regenerates the bundle on every `pnpm build` and `pnpm validate:fast`, and the CLI process tests spawn the bundle rather than `src/cli.ts`, so the committed bundle is the one that passed the tests. A merge conflict in the bundle is resolved by running `pnpm build`, never by hand.

### Why Node 24 only

The repository pins Node 24 in `.nvmrc` and `devEngines`, and the bundle targets `node24`. It has no runtime version check, and no new CLI error code: the docs state the requirement.

### For the spec

- [CLI](../spec.md#cli): Agents run it from a checkout with nothing but Node 24, as `node apps/cli/bundle/resend-challenge.mjs …`.
- [CLI process tests](../spec.md#cli-process-tests): they start the committed bundle.
- [Future increments](../spec.md#16-future-increments): "a CLI published to npm" replaces "Distributing the CLI".
