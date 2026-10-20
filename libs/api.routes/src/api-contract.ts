import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";

import { errorResponseSchema } from "#src/errors.ts";

/** The published OpenAPI document; the only API path served without authentication. */
export const OPENAPI_DOCUMENT_PATH = "/api/openapi.json";

const SECURITY_SCHEME = {
  AGENT: "agentAuth",
  REVIEWER: "reviewerAuth",
} as const;

/**
 * Creates the OpenAPI app that carries the API contract and serves its OpenAPI 3.1 document at
 * {@link OPENAPI_DOCUMENT_PATH}.
 */
export function createApiContractApp<E extends Env>(): OpenAPIHono<E> {
  const app = new OpenAPIHono<E>();

  app.openAPIRegistry.registerComponent("securitySchemes", SECURITY_SCHEME.AGENT, {
    type: "http",
    scheme: "bearer",
    description: "The Agent token (`agent_…`), shared by every Agent.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", SECURITY_SCHEME.REVIEWER, {
    type: "http",
    scheme: "bearer",
    description: "The Reviewer token (`reviewer_…`), held by the human Reviewer only.",
  });
  app.openAPIRegistry.register("ErrorResponse", errorResponseSchema);

  app.doc31(OPENAPI_DOCUMENT_PATH, {
    openapi: "3.1.0",
    info: {
      title: "Email Draft Approval API",
      version: "1.0.0",
      description:
        "Agents create, revise and submit email Drafts; a human Reviewer approves or rejects the submitted Revision in the Review UI, and an Approval sends the email through Resend. Every route except this document requires a bearer token. Errors use the `ErrorResponse` envelope.",
    },
  });

  return app;
}
