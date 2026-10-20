import { writeDirectoryTree } from "@patricktree-stack/test-utils-node";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterEach, expect, test } from "vitest";

const CLI = url.fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TYPE_STRIPPING_CONFIG = url.fileURLToPath(
  import.meta
    .resolve("@patricktree-stack/config-typescript/tsconfig.typescript-execution-via-type-stripping.json"),
);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cleans stale declarations and metadata while preserving aliases, conditions, and other manifest fields", async () => {
  const manifest = {
    type: "module",
    imports: {
      "#src/*.ts": "./*.ts",
      "#component/*.tsx": "./components/*.tsx",
      "#esm/*.mts": "./*.mts",
      "#esm-component/*.mtsx": "./components/*.mtsx",
      "#cjs/*.cts": "./*.cts",
      "#cjs-component/*.ctsx": "./components/*.ctsx",
      "#test/*.ts": "./test/*.ts",
      "#conditional": {
        custom: ["./first.ts", null, "dependency/file.ts"],
        default: "./fallback.tsx",
      },
      "#existing": "./already.d.ts",
      "#existing-esm": "./already.d.mts",
      "#existing-cjs": "./already.d.cts",
      "#existing-esm-component": "./already.d.mtsx",
      "#existing-cjs-component": "./already.d.ctsx",
      "#asset": "./encoder.wasm",
      "#external": "node:fs",
    },
  };
  const root = await createPackage(
    `
    ├── src
    │   └── package.json
    └── dist
        ├── types
        │   └── stale.d.ts
        ├── tsconfig.build.tsbuildinfo
        ├── another.tsbuildinfo
        └── keep.json
    `,
    {
      "src/package.json": JSON.stringify(manifest),
      "dist/types/stale.d.ts": "stale",
      "dist/tsconfig.build.tsbuildinfo": "old build",
      "dist/another.tsbuildinfo": "another build",
      "dist/keep.json": "{}",
    },
  );

  const result = prepare(root, ["--build-info-file", "./dist/another.tsbuildinfo"]);

  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(await fs.readdir(path.join(root, "dist/types"))).toEqual(["package.json"]);
  expect(await fs.readdir(path.join(root, "dist"))).toEqual(["keep.json", "types"]);
  expect(JSON.parse(await fs.readFile(path.join(root, "dist/types/package.json"), "utf8"))).toEqual(
    {
      ...manifest,
      imports: {
        ...manifest.imports,
        "#src/*.ts": "./*.d.ts",
        "#component/*.tsx": "./components/*.d.ts",
        "#esm/*.mts": "./*.d.mts",
        "#esm-component/*.mtsx": "./components/*.d.mts",
        "#cjs/*.cts": "./*.d.cts",
        "#cjs-component/*.ctsx": "./components/*.d.cts",
        "#test/*.ts": "./test/*.d.ts",
        "#conditional": {
          custom: ["./first.d.ts", null, "dependency/file.ts"],
          default: "./fallback.d.ts",
        },
      },
    },
  );
});

test("preserves inferred consumer types and reports deleted internal sources without resolving stale declarations", async () => {
  const root = await createPackage(
    `
    ├── src
    │   ├── package.json
    │   ├── index.ts
    │   └── detail.ts
    ├── package.json
    ├── tsconfig.json
    ├── consumer.ts
    └── tsconfig.consumer.json
    `,
    {
      "src/package.json": JSON.stringify({ type: "module", imports: { "#src/*": "./*" } }),
      "src/index.ts": 'export { inferred } from "#src/detail.ts";',
      "src/detail.ts": "export const inferred = () => ({ count: 123 });",
      "package.json": JSON.stringify({
        name: "producer",
        type: "module",
        exports: { ".": { types: "./dist/types/index.d.ts", default: "./src/index.ts" } },
      }),
      "tsconfig.json": JSON.stringify({
        extends: TYPE_STRIPPING_CONFIG,
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: "./src",
          outDir: "dist/types",
        },
        include: ["src/**/*"],
      }),
      "consumer.ts":
        'import { inferred } from "producer";\nconst count: number = inferred().count;\n// @ts-expect-error inferred count must not be string or any\nconst wrong: string = inferred().count;',
      "tsconfig.consumer.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
        },
        files: ["consumer.ts"],
      }),
    },
  );

  expect(prepare(root).status).toBe(0);
  const build = childProcess.spawnSync("tsc", ["--build"], { cwd: root, encoding: "utf8" });
  expect({ status: build.status, diagnostics: build.stdout + build.stderr }).toEqual({
    status: 0,
    diagnostics: "",
  });
  const consumer = childProcess.spawnSync("tsc", ["-p", "tsconfig.consumer.json"], {
    cwd: root,
    encoding: "utf8",
  });
  expect({ status: consumer.status, diagnostics: consumer.stdout + consumer.stderr }).toEqual({
    status: 0,
    diagnostics: "",
  });

  await fs.unlink(path.join(root, "src/detail.ts"));
  const sourceCheck = childProcess.spawnSync("tsc", ["--build", "--force"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(sourceCheck.status).not.toBe(0);
  expect(sourceCheck.stdout).toContain("Cannot find module '#src/detail.ts'");
  expect(await fs.stat(path.join(root, "dist/types/detail.d.ts"))).toBeDefined();

  expect(prepare(root).status).toBe(0);
  expect(await fs.readdir(path.join(root, "dist/types"))).toEqual(["package.json"]);
});

test.each([".", "./src", "../outside"])(
  "rejects unsafe declaration cleanup directory %s before deleting files",
  async (output) => {
    const root = await createPackage();
    const result = prepare(root, [], output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Declaration output must be inside the current package");
    expect(await fs.readFile(path.join(root, "src/package.json"), "utf8")).toBe("{}");
  },
);

test("rejects malformed import targets before cleanup", async () => {
  const root = await createPackage(
    `
    ├── src
    │   └── package.json
    └── dist
        └── types
            └── keep.d.ts
    `,
    {
      "src/package.json": '{"imports":{"#broken":42}}',
      "dist/types/keep.d.ts": "keep",
    },
  );
  const result = prepare(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Import targets must be");
  expect(await fs.readFile(path.join(root, "dist/types/keep.d.ts"), "utf8")).toBe("keep");
});

test("expands generic aliases into declaration mappings without overriding explicit mappings", async () => {
  const root = await createPackage(
    `
    └── src
        └── package.json
    `,
    {
      "src/package.json": JSON.stringify({
        type: "module",
        imports: {
          "#src/*": { custom: ["./alternative/*", "dependency/*", null], default: "./*" },
          "#src/*.mts": "./esm/*.mts",
        },
      }),
    },
  );

  expect(prepare(root).status).toBe(0);
  const generated = JSON.parse(
    await fs.readFile(path.join(root, "dist/types/package.json"), "utf8"),
  );
  expect(generated.imports).toEqual({
    "#src/*.ts": { custom: ["./alternative/*.d.ts", "dependency/*.ts", null], default: "./*.d.ts" },
    "#src/*.tsx": {
      custom: ["./alternative/*.d.ts", "dependency/*.tsx", null],
      default: "./*.d.ts",
    },
    "#src/*.mtsx": {
      custom: ["./alternative/*.d.mts", "dependency/*.mtsx", null],
      default: "./*.d.mts",
    },
    "#src/*.ctsx": {
      custom: ["./alternative/*.d.cts", "dependency/*.ctsx", null],
      default: "./*.d.cts",
    },
    "#src/*.cts": {
      custom: ["./alternative/*.d.cts", "dependency/*.cts", null],
      default: "./*.d.cts",
    },
    "#src/*": { custom: ["./alternative/*", "dependency/*", null], default: "./*" },
    "#src/*.mts": "./esm/*.d.mts",
  });
});

async function createPackage(
  tree = `
  └── src
      └── package.json
  `,
  files: Record<string, string> = { "src/package.json": "{}" },
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "draft-approval-declaration-build-"));
  directories.push(root);
  await writeDirectoryTree(root, tree, files);
  return root;
}

function prepare(root: string, extraArgs: string[] = [], output = "./dist/types") {
  return childProcess.spawnSync(
    process.execPath,
    [
      CLI,
      "--declaration-output-dir",
      output,
      "--build-info-file",
      "./dist/tsconfig.tsbuildinfo",
      "--build-info-file",
      "./dist/tsconfig.build.tsbuildinfo",
      ...extraArgs,
      "--source-package-json",
      "./src/package.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
}
