# Prepare declaration builds

This CLI removes stale declaration outputs and build metadata, then mirrors a checked-in source package manifest into the declaration directory. It is copied from cup's `tooling/prepare-declaration-build`.

## Why

Packages run their TypeScript sources directly (Node's type stripping, Vite, Wrangler), while consumers type-check against declarations that `tsc --build` emits into `dist/types`. A checked-in `src/package.json` supplies the source-local `#src/*` imports; mirroring it into `dist/types/package.json` with rewritten targets gives the emitted declarations their own package scope. Clearing the declaration directory first removes declarations left behind by renamed or deleted source files.

## Usage

```sh
prepare-declaration-build \
  --declaration-output-dir ./dist/types \
  --build-info-file ./dist/tsconfig.build.tsbuildinfo \
  --source-package-json ./src/package.json
```

Run it before `tsc --build`. Paths resolve from the current working directory. Repeat `--build-info-file` for additional build metadata. The CLI reads no TypeScript configuration and discovers no workspace packages. Its executable runs directly from TypeScript source through Node's type stripping.

Cleanup paths must remain inside the current package. The declaration directory must be outside the source manifest's directory, and build metadata paths must end in `.tsbuildinfo`. Manifest parsing and rewriting complete before deletion begins.

## Manifest rewriting

The source manifest is copied with local `imports` target endings rewritten: `.ts` and `.tsx` become `.d.ts`, `.mts` and `.mtsx` become `.d.mts`, and `.cts` and `.ctsx` become `.d.cts`. Generic mappings such as `"#src/*": "./*"` also produce explicit `.ts`, `.tsx`, `.mts`, `.mtsx`, `.cts`, and `.ctsx` declaration mappings. Existing explicit mappings take precedence; the generic mapping remains available for other files. Conditions, arrays, null targets, existing declaration extensions, and other manifest fields remain unchanged.

The CLI writes the generated manifest to `package.json` inside the declaration output directory. Local imports retain their relative layout; the CLI does not rebase targets or copy assets.
