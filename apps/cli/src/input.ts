import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

import { ERROR_CODE } from "@resend-challenge/api.client";
import { toValidationIssues } from "@resend-challenge/api.routes";

import { CliError } from "./cli-error.ts";

/**
 * Validates input with one of the contract's schemas, before any request. A violation throws
 * `INVALID_REQUEST` with `issues: [{ path, message }]`, like the API's own 400; the message names
 * each issue by its command-line argument, and a list element also by its value.
 *
 * A field is named after the option or positional argument of `command` with its name, such as
 * `--limit` for `limit`; `argumentNameOverrides` names the fields that have none.
 */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: z.input<Schema>,
  command: CommandUnknownOpts,
  argumentNameOverrides: Partial<Record<string, string>> = {},
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const issues = toValidationIssues(result.error.issues);
  const descriptions = issues.map(({ path: issuePath, message }) => {
    const subject = describeIssueSubject(issuePath, input, command, argumentNameOverrides);
    // Every description ends in one period, whether or not Zod's message has one.
    return `${subject}: ${message.replace(/\.$/, "")}`;
  });
  throw new CliError(ERROR_CODE.INVALID_REQUEST, `Invalid input. ${descriptions.join("; ")}.`, {
    issues,
  });
}

/** The argument of the body as the caller passed it, `--body` or `--body-file`. */
export function getBodyArgumentName({ body }: BodyOptions): string {
  return body === undefined ? "--body-file" : "--body";
}

type BodyOptions = { body?: string | undefined; bodyFile?: string | undefined };

/**
 * The plain-text body from `--body`, or from the file or stdin (`-`) that `--body-file` names.
 * Commander already refuses both options together.
 */
export async function readBody({ body, bodyFile }: BodyOptions): Promise<string> {
  if (body !== undefined) {
    return body;
  }
  if (bodyFile === undefined) {
    throw new CliError(ERROR_CODE.INVALID_REQUEST, "Pass the body with --body or --body-file.");
  }

  try {
    return bodyFile === "-"
      ? await readStdin()
      : await fs.readFile(resolveCallerPath(bodyFile), "utf8");
  } catch (error) {
    throw new CliError(
      ERROR_CODE.INVALID_REQUEST,
      `Could not read --body-file "${bodyFile}": ${error instanceof Error ? error.message : "read failed"}.`,
    );
  }
}

/**
 * `pnpm resend-challenge` runs the CLI in the repository root and keeps the directory it was called
 * from in `INIT_CWD`, so a relative path means what the caller expects.
 */
function resolveCallerPath(filePath: string): string {
  return path.resolve(process.env["INIT_CWD"] ?? process.cwd(), filePath);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The argument an issue is about, such as `--subject`; for a list element, also its value, since
 * the caller passed values rather than indexes.
 */
function describeIssueSubject(
  issuePath: readonly (string | number)[],
  input: unknown,
  command: CommandUnknownOpts,
  argumentNameOverrides: Partial<Record<string, string>>,
): string {
  const [field, index] = issuePath;
  if (typeof field !== "string") {
    return "input";
  }
  const argumentName = argumentNameOverrides[field] ?? findArgumentName(command, field) ?? field;

  const element = typeof index === "number" ? readListElement(input, field, index) : undefined;
  return element === undefined ? argumentName : `${argumentName} ${JSON.stringify(element)}`;
}

function findArgumentName(command: CommandUnknownOpts, field: string): string | undefined {
  const option = command.options.find((candidate) => candidate.attributeName() === field);
  if (option?.long !== undefined) {
    return option.long;
  }
  const argument = command.registeredArguments.find((candidate) => candidate.name() === field);
  return argument === undefined ? undefined : `<${argument.name()}>`;
}

function readListElement(input: unknown, field: string, index: number): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const list: unknown = Reflect.get(input, field);
  if (!Array.isArray(list)) {
    return undefined;
  }
  const element: unknown = list[index];
  return typeof element === "string" ? element : undefined;
}
