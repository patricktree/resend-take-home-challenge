import { Hono } from "hono";
import crypto from "node:crypto";

import { createApiContractApp, ERROR_CODE } from "@draft-approval/api.routes";

import type { ApiServerHonoEnvironment } from "#src/api-server-environment.ts";
import { authenticate } from "#src/authentication.ts";
import { jsonError } from "#src/http-errors.ts";

export type { ApiServerEnvironment } from "#src/api-server-environment.ts";

/** Creates the Hono app that answers every `fetch` of the Worker. */
export function createApiServer(): Hono<ApiServerHonoEnvironment> {
  const app = new Hono<ApiServerHonoEnvironment>();

  app.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    await next();
    context.header("X-Request-Id", context.get("requestId"));
  });

  app.onError((error, context) => {
    console.error(findRootCause(error));
    return jsonError(context, 500, ERROR_CODE.INTERNAL_ERROR, "An internal error occurred.");
  });

  app.notFound((context) =>
    jsonError(context, 404, ERROR_CODE.NOT_FOUND, "No route matches this path."),
  );

  app.get("/", (context) => context.redirect("/app/", 302));

  app.use("/api/*", authenticate);
  app.route("/", createApiContractApp<ApiServerHonoEnvironment>());

  return app;
}

/** Error reporting logs the innermost cause, the error that actually went wrong. */
function findRootCause(error: Error): unknown {
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
  }
  return cause;
}
