import { z } from "@hono/zod-openapi";

import { verdictSchema } from "./drafts.ts";

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Everything an error envelope carries besides code, message and request id, such as `issues`. */
export type ErrorExtras = Omit<ErrorResponse["error"], "code" | "message" | "requestId">;

export const ERROR_CODE = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /** The Reviewer token on `/mcp`, which accepts only the Agent token. */
  AGENT_ONLY: "AGENT_ONLY",
  /** The Agent token on the verdict routes, which accept only the Reviewer token. */
  REVIEWER_ONLY: "REVIEWER_ONLY",
  NOT_FOUND: "NOT_FOUND",
  DRAFT_NOT_FOUND: "DRAFT_NOT_FOUND",
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  REVISION_SUPERSEDED: "REVISION_SUPERSEDED",
  REVISION_ALREADY_DECIDED: "REVISION_ALREADY_DECIDED",
  REVISION_ALREADY_SUBMITTED: "REVISION_ALREADY_SUBMITTED",
  REVISION_NOT_SUBMITTED: "REVISION_NOT_SUBMITTED",
  DRAFT_APPROVED: "DRAFT_APPROVED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

const validationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])).openapi({
      description: 'Where the issue is, for example `["to", 0]`; empty for the whole request part',
    }),
    message: z.string().openapi({ description: "What is wrong" }),
  })
  .openapi("ValidationIssue");

/** The envelope of every error response; extras such as `issues` sit inside `error`. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODE).openapi({ description: "Machine-readable error code" }),
      message: z.string().openapi({ description: "Human-readable description of the error" }),
      requestId: z
        .string()
        .openapi({ description: "The request's id, also sent as the `X-Request-Id` header" }),
      issues: z.array(validationIssueSchema).optional().openapi({
        description: "With `INVALID_REQUEST`: every violation of the request's schema",
      }),
      existingVerdict: verdictSchema.optional().openapi({
        description: "With `REVISION_ALREADY_DECIDED`: the verdict the Revision already has",
      }),
    }),
  })
  .openapi("ErrorResponse");

/**
 * Maps Zod's issues to the `issues` of an `INVALID_REQUEST` error. The API's request validation and
 * the CLI's validation before any request both use it, so their `issues` have the same shape.
 */
export function toValidationIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): z.infer<typeof validationIssueSchema>[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
    message: issue.message,
  }));
}
