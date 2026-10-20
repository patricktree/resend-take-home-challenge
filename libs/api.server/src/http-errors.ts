import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { ErrorCode, ErrorResponse } from "@draft-approval/api.routes";

import type { ApiServerHonoEnvironment } from "#src/api-server-environment.ts";

/** Answers with the error envelope, carrying the request's id. */
export function jsonError(
  context: Context<ApiServerHonoEnvironment>,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  headers?: Record<string, string>,
): Response {
  const body: ErrorResponse = { error: { code, message, requestId: context.get("requestId") } };
  return context.json(body, status, headers);
}
