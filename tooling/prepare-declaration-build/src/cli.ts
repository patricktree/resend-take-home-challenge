#!/usr/bin/env node
import { Command, CommanderError } from "@commander-js/extra-typings";

import { prepareDeclarationBuild } from "#src/prepare-declaration-build.ts";

export async function runCli(args: string[]): Promise<number> {
  const program = new Command()
    .name("prepare-declaration-build")
    .description(
      "Clean declaration outputs and mirror source package imports into their package scope",
    )
    .showHelpAfterError()
    .exitOverride()
    .requiredOption(
      "--declaration-output-dir <directory>",
      "declaration directory to clean and prepare",
    )
    .requiredOption(
      "--build-info-file <file>",
      "build metadata to remove; repeat for multiple files",
      (file, previous: string[]) => [...previous, file],
      [],
    )
    .requiredOption("--source-package-json <file>", "source manifest to mirror")
    .action(prepareDeclarationBuild);

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    console.error(error instanceof Error ? error.message : "Declaration build preparation failed.");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
