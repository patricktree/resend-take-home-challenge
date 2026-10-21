import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

import { ERROR_CODE } from "@resend-challenge/api.routes";

import { CliError } from "#src/cli-error.ts";

/** The command-line names of the request fields, so a validation message names what to fix. */
const ARGUMENT_NAMES: Record<string, string> = {
  draftId: "<draftId>",
  revisionId: "<revisionId>",
  to: "--to",
  subject: "--subject",
  body: "--body",
  baseRevisionId: "--base-revision",
  reviewStatus: "--review-status",
  sendingStatus: "--sending-status",
  orderBy: "--order-by",
  order: "--order",
  limit: "--limit",
  cursor: "--cursor",
};

/**
 * Validates input with one of the contract's schemas, before any request. A violation throws
 * `INVALID_REQUEST` with `issues: [{ path, message }]`, like the API's own 400.
 */
export function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: z.input<Schema>,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    message: issue.message,
  }));
  const descriptions = issues.map(({ path: issuePath, message }) => {
    const [field] = issuePath;
    const argumentName = typeof field === "string" ? (ARGUMENT_NAMES[field] ?? field) : "input";
    return `${argumentName}: ${message}`;
  });
  throw new CliError(ERROR_CODE.INVALID_REQUEST, `Invalid input. ${descriptions.join(" ")}`, {
    issues,
  });
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
