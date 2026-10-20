import fs from "node:fs/promises";
import type { z } from "zod";

import { ERROR_CODE } from "@draft-approval/api.routes";

import { CliError } from "#src/cli-error.ts";

type BodyOptions = { body?: string | undefined; bodyFile?: string | undefined };

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
  const descriptions = issues.map(({ path, message }) => {
    const [field] = path;
    const argumentName = typeof field === "string" ? (ARGUMENT_NAMES[field] ?? field) : "input";
    return `${argumentName}: ${message}`;
  });
  throw new CliError(ERROR_CODE.INVALID_REQUEST, `Invalid input. ${descriptions.join(" ")}`, {
    issues,
  });
}

/** The plain-text body from `--body`, or from the file or stdin (`-`) that `--body-file` names. */
export async function readBody({ body, bodyFile }: BodyOptions): Promise<string> {
  if (body !== undefined && bodyFile !== undefined) {
    throw new CliError(ERROR_CODE.INVALID_REQUEST, "Pass either --body or --body-file, not both.");
  }
  if (body !== undefined) {
    return body;
  }
  if (bodyFile === undefined) {
    throw new CliError(ERROR_CODE.INVALID_REQUEST, "Pass the body with --body or --body-file.");
  }

  try {
    return bodyFile === "-" ? await readStdin() : await fs.readFile(bodyFile, "utf8");
  } catch (error) {
    throw new CliError(
      ERROR_CODE.INVALID_REQUEST,
      `Could not read --body-file "${bodyFile}": ${error instanceof Error ? error.message : "read failed"}.`,
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
