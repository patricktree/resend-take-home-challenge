import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { ErrorCode, ErrorExtras, ErrorResponse } from "@resend-challenge/api.routes";

import type { ApiServerHonoEnvironment } from "./api-server-environment.ts";

/**
 * Answers with the error envelope, carrying the request's id. The response is typed with its
 * status, so route handlers can return it for the error responses their route declares.
 */
export function jsonError<Status extends ContentfulStatusCode>(
  context: Context<ApiServerHonoEnvironment>,
  status: Status,
  code: ErrorCode,
  message: string,
  { headers, extras }: { headers?: Record<string, string>; extras?: ErrorExtras } = {},
) {
  const body: ErrorResponse = {
    error: { code, message, requestId: context.get("requestId"), ...extras },
  };
  return context.json(body, status, headers);
}
