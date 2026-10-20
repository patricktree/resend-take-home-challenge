import { z } from "@hono/zod-openapi";

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const ERROR_CODE = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

/** The envelope of every error response; extras such as `issues` sit inside `error`. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODE).openapi({ description: "Machine-readable error code" }),
      message: z.string().openapi({ description: "Human-readable description of the error" }),
      requestId: z
        .string()
        .openapi({ description: "The request's id, also sent as the `X-Request-Id` header" }),
    }),
  })
  .openapi("ErrorResponse");
