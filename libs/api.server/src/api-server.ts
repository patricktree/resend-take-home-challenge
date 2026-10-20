import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import crypto from "node:crypto";

import { createApiContractApp, ERROR_CODE, REVIEWER_ONLY_ROUTES } from "@draft-approval/api.routes";

import type { ApiServerHonoEnvironment } from "#src/api-server-environment.ts";
import { authenticate, requireReviewer } from "#src/authentication.ts";
import { runOnDatabaseSession } from "#src/database-session.ts";
import { DRAFT_HANDLERS } from "#src/draft-handlers.ts";
import { jsonError } from "#src/http-errors.ts";
import { createMcpEndpoint, MCP_PATH, requireAgent } from "#src/mcp-endpoint.ts";
import { mountReviewUi } from "#src/review-ui.ts";

export type { ApiServerEnvironment } from "#src/api-server-environment.ts";

/** Requests are buffered and validated as a whole, so their size is capped. */
const MAX_REQUEST_BODY_BYTES = 128 * 1024;

/** Creates the Hono app that answers every `fetch` of the Worker. */
export function createApiServer(): Hono<ApiServerHonoEnvironment> {
  const app = new Hono<ApiServerHonoEnvironment>();

  app.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    await next();
    context.header("X-Request-Id", context.get("requestId"));
  });

  app.onError((error, context) => {
    const requestIssue = describeUnreadableRequestBody(error);
    if (requestIssue !== undefined) {
      return jsonError(
        context,
        400,
        ERROR_CODE.INVALID_REQUEST,
        "The request is invalid; see `issues`.",
        { extras: { issues: [{ path: [], message: requestIssue }] } },
      );
    }

    console.error(findRootCause(error));
    return jsonError(context, 500, ERROR_CODE.INTERNAL_ERROR, "An internal error occurred.");
  });

  app.notFound((context) =>
    jsonError(context, 404, ERROR_CODE.NOT_FOUND, "No route matches this path."),
  );

  app.get("/", (context) => context.redirect("/app/", 302));
  mountReviewUi(app);

  app.use("/api/*", authenticate);
  // Before the database session middleware: an Agent's verdict request never reaches D1.
  for (const route of REVIEWER_ONLY_ROUTES) {
    app.on(route.method, route.path, requireReviewer);
  }
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (context) =>
        jsonError(
          context,
          413,
          ERROR_CODE.PAYLOAD_TOO_LARGE,
          `The request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`,
        ),
    }),
  );
  app.use("/api/v1/*", runOnDatabaseSession);
  app.route("/", createApiContractApp<ApiServerHonoEnvironment>(DRAFT_HANDLERS));

  app.all(MCP_PATH, authenticate, requireAgent, createMcpEndpoint(app));

  return app;
}

/**
 * Describes the errors that the contract's validators throw before any schema check: Hono's JSON
 * validator throws 400 for a body that does not parse, and `@hono/zod-openapi` throws 415 for a
 * body that is not declared JSON. The API answers both with 400 `INVALID_REQUEST`.
 */
function describeUnreadableRequestBody(error: Error): string | undefined {
  if (!(error instanceof HTTPException)) {
    return undefined;
  }

  switch (error.status) {
    case 400: {
      return error.message;
    }
    case 415: {
      return "The request body must be JSON, sent with `Content-Type: application/json`.";
    }
    default: {
      return undefined;
    }
  }
}

/**
 * Error reporting logs only the innermost cause, the error that actually went wrong: wrapping
 * errors add no diagnosis, and some (such as Drizzle's) carry SQL parameters, which must not be
 * logged.
 */
function findRootCause(error: Error): unknown {
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
  }
  return cause;
}
