import fs from "node:fs/promises";
import path from "node:path";

export async function prepareDeclarationBuild(options: {
  declarationOutputDir: string;
  buildInfoFile: string[];
  sourcePackageJson: string;
}) {
  const packageRoot = await fs.realpath(process.cwd());
  const outputDirectory = await resolveCleanupPath(path.resolve(options.declarationOutputDir));
  const sourceManifest = await fs.realpath(path.resolve(options.sourcePackageJson));
  const sourceDirectory = path.dirname(sourceManifest);
  const buildInfoFiles = await Promise.all(
    options.buildInfoFile.map((file) => resolveCleanupPath(path.resolve(file))),
  );

  if (
    !isWithin(packageRoot, outputDirectory) ||
    outputDirectory === sourceDirectory ||
    isWithin(outputDirectory, sourceDirectory) ||
    isWithin(sourceDirectory, outputDirectory)
  ) {
    throw new Error(
      "Declaration output must be inside the current package and outside its source directory.",
    );
  }
  if (!isWithin(packageRoot, sourceManifest)) {
    throw new Error("Source package.json must be inside the current package.");
  }
  if (
    buildInfoFiles.length === 0 ||
    buildInfoFiles.some((file) => !isWithin(packageRoot, file) || !file.endsWith(".tsbuildinfo"))
  ) {
    throw new Error("Specify at least one .tsbuildinfo file inside the current package.");
  }

  const manifest: unknown = JSON.parse(await fs.readFile(sourceManifest, "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Source package.json must contain an object.");
  }

  const generated = { ...manifest };
  if ("imports" in generated) {
    const imports = generated.imports;
    if (imports === null || typeof imports !== "object" || Array.isArray(imports)) {
      throw new Error("Source package.json imports must contain an object.");
    }
    generated.imports = Object.fromEntries(
      Object.entries(imports).flatMap(([specifier, target]) => {
        const rewritten: [string, unknown][] = [[specifier, rewriteTarget(target)]];
        if (!specifier.endsWith("*") || !hasLocalWildcardTarget(target)) {
          return rewritten;
        }

        const extensions = ["ts", "tsx", "mts", "mtsx", "cts", "ctsx"];
        const expanded = extensions
          .filter((extension) => !Object.hasOwn(imports, `${specifier}.${extension}`))
          .map((extension): [string, unknown] => [
            `${specifier}.${extension}`,
            rewriteTarget(expandWildcardTarget(target, extension)),
          ]);
        return [...expanded, ...rewritten];
      }),
    );
  }
  const content = `${JSON.stringify(generated, null, 2)}\n`;

  await fs.rm(outputDirectory, { recursive: true, force: true });
  for (const file of buildInfoFiles) {
    await fs.rm(file, { force: true });
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, "package.json"), content);
}

function rewriteTarget(target: unknown): unknown {
  if (target === null) {
    return null;
  }
  if (typeof target === "string") {
    if (!target.startsWith("./") || /\.d\.(?:[mc]?tsx?)$/.test(target)) {
      return target;
    }
    return target.replace(/\.([mc]?tsx?)$/, (_, extension: string) =>
      extension.startsWith("m") ? ".d.mts" : extension.startsWith("c") ? ".d.cts" : ".d.ts",
    );
  }
  if (Array.isArray(target)) {
    return target.map(rewriteTarget);
  }
  if (typeof target === "object") {
    return Object.fromEntries(
      Object.entries(target).map(([condition, value]) => [condition, rewriteTarget(value)]),
    );
  }
  throw new Error("Import targets must be strings, conditional objects, arrays, or null.");
}

function isWithin(directory: string, target: string) {
  const relative = path.relative(directory, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveCleanupPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    return path.join(await resolveCleanupPath(path.dirname(target)), path.basename(target));
  }
}

function hasLocalWildcardTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return target.startsWith("./") && target.endsWith("*");
  }
  if (Array.isArray(target)) {
    return target.some(hasLocalWildcardTarget);
  }
  if (target !== null && typeof target === "object") {
    return Object.values(target).some(hasLocalWildcardTarget);
  }
  return false;
}

function expandWildcardTarget(target: unknown, extension: string): unknown {
  if (typeof target === "string") {
    return target.replaceAll("*", `*.${extension}`);
  }
  if (Array.isArray(target)) {
    return target.map((value) => expandWildcardTarget(value, extension));
  }
  if (target !== null && typeof target === "object") {
    return Object.fromEntries(
      Object.entries(target).map(([condition, value]) => [
        condition,
        expandWildcardTarget(value, extension),
      ]),
    );
  }
  return target;
}
