import { createRoute, OpenAPIHono, z, type RouteHandler } from "@hono/zod-openapi";

import {
  draftDataRequestSchema,
  draftListSchema,
  draftParamsSchema,
  draftSchema,
  draftSummarySchema,
  listDraftsQuerySchema,
  rejectionRequestSchema,
  reviseRequestSchema,
  revisionParamsSchema,
  revisionSchema,
} from "./drafts.ts";
import {
  ERROR_CODE,
  errorResponseSchema,
  toValidationIssues,
  type ErrorResponse,
} from "./errors.ts";

/** What the contract needs from the app's environment: the request id of every error envelope. */
export type ApiContractEnvironment = { Variables: { requestId: string } };

/** The handlers of every API route, which the API server provides. */
export type ApiHandlers<E extends ApiContractEnvironment> = {
  createDraft: RouteHandler<typeof createDraftRoute, E>;
  getDraft: RouteHandler<typeof getDraftRoute, E>;
  reviseDraft: RouteHandler<typeof reviseDraftRoute, E>;
  getRevision: RouteHandler<typeof getRevisionRoute, E>;
  submitRevision: RouteHandler<typeof submitRevisionRoute, E>;
  listDrafts: RouteHandler<typeof listDraftsRoute, E>;
  approveRevision: RouteHandler<typeof approveRevisionRoute, E>;
  rejectRevision: RouteHandler<typeof rejectRevisionRoute, E>;
};

/** The contract app's type, from which the typed client infers every route. */
export type ApiContractApp = ReturnType<typeof createApiContractApp<ApiContractEnvironment>>;

/** The published OpenAPI document; the only API path served without authentication. */
export const OPENAPI_DOCUMENT_PATH = "/api/openapi.json";

/** The read bookmark header, on requests and responses of every API operation. */
export const READ_BOOKMARK_HEADER = "X-Read-Bookmark";

const SECURITY_SCHEME = {
  AGENT: "agentAuth",
  REVIEWER: "reviewerAuth",
} as const;

/** Both the Agent token and the Reviewer token may call the route. */
const AGENT_OR_REVIEWER_SECURITY = [
  { [SECURITY_SCHEME.AGENT]: [] },
  { [SECURITY_SCHEME.REVIEWER]: [] },
];

/** Only the Reviewer token may call the route; the API server guards it (`REVIEWER_ONLY_ROUTES`). */
const REVIEWER_ONLY_SECURITY = [{ [SECURITY_SCHEME.REVIEWER]: [] }];

const READ_BOOKMARK_DESCRIPTION =
  "The D1 read bookmark. Send the latest value you received on every request to read your own writes; every response returns the current one.";

const readBookmarkRequestHeadersSchema = z.object({
  // Lowercase: Hono validates request headers by their lowercased names.
  "x-read-bookmark": z.string().optional().openapi({ description: READ_BOOKMARK_DESCRIPTION }),
});

const readBookmarkResponseHeadersSchema = z.object({
  [READ_BOOKMARK_HEADER]: z.string().openapi({ description: READ_BOOKMARK_DESCRIPTION }),
});

const PAYLOAD_TOO_LARGE_DESCRIPTION = "`PAYLOAD_TOO_LARGE`: the request body exceeds 128 KB.";

/** For the routes that take no request body: the body limit guards every request all the same. */
const NO_BODY_PAYLOAD_TOO_LARGE_DESCRIPTION =
  "`PAYLOAD_TOO_LARGE`: the request body exceeds 128 KB; this operation takes no body.";

/** Error responses carry the read bookmark only when the request got as far as the database. */
const errorResponseHeadersSchema = z.object({
  [READ_BOOKMARK_HEADER]: z.string().optional().openapi({ description: READ_BOOKMARK_DESCRIPTION }),
});

const createDraftRoute = createRoute({
  method: "post",
  path: "/api/v1/drafts",
  operationId: "createDraft",
  tags: ["Drafts"],
  summary: "Create a Draft",
  description:
    "Creates a Draft whose first Revision holds the given Draft data, `UNSUBMITTED`. Creating never submits: submit the Revision for review separately. Not idempotent: a retried create may create a second Draft.",
  security: AGENT_OR_REVIEWER_SECURITY,
  request: {
    headers: readBookmarkRequestHeadersSchema,
    body: {
      required: true,
      content: { "application/json": { schema: draftDataRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "The created Draft, without the body.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: draftSummarySchema } },
    },
    400: errorResponse(
      "`INVALID_REQUEST`: the request violates the schema or a limit; see `issues`.",
    ),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    413: errorResponse(PAYLOAD_TOO_LARGE_DESCRIPTION),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

const getDraftRoute = createRoute({
  method: "get",
  path: "/api/v1/drafts/{draftId}",
  operationId: "getDraft",
  tags: ["Drafts"],
  summary: "Get a Draft",
  description:
    "Returns the Draft with its latest Revision, including the body, its review status, its sending status and the newest verdict.",
  security: AGENT_OR_REVIEWER_SECURITY,
  request: {
    params: draftParamsSchema,
    headers: readBookmarkRequestHeadersSchema,
  },
  responses: {
    200: {
      description: "The Draft, with the latest Revision's body.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: draftSchema } },
    },
    400: errorResponse("`INVALID_REQUEST`: the Draft id or a header is malformed; see `issues`."),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    404: errorResponse("`DRAFT_NOT_FOUND`: no Draft has this id."),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

const reviseDraftRoute = createRoute({
  method: "post",
  path: "/api/v1/drafts/{draftId}/revisions",
  operationId: "reviseDraft",
  tags: ["Drafts"],
  summary: "Revise a Draft",
  description:
    "Creates the Draft's next Revision, `UNSUBMITTED`, from the given Draft data. `baseRevisionId` names the Revision the change builds on, the latest Revision as you last read it; if another revise came first, nothing is written and the result is 409 `REVISION_SUPERSEDED`, which guards against lost updates and against duplicate Revisions from retries. Revising supersedes an Unsubmitted or Pending base, which withdraws its Submission; a Rejected base stays Rejected. Revising never submits: submit the new Revision separately. An approved Draft accepts no further Revisions.",
  security: AGENT_OR_REVIEWER_SECURITY,
  request: {
    params: draftParamsSchema,
    headers: readBookmarkRequestHeadersSchema,
    body: {
      required: true,
      content: { "application/json": { schema: reviseRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "The revised Draft with its new latest Revision, without the body.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: draftSummarySchema } },
    },
    400: errorResponse(
      "`INVALID_REQUEST`: the request violates the schema or a limit; see `issues`.",
    ),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    404: errorResponse(
      "`DRAFT_NOT_FOUND`: no Draft has this id. `REVISION_NOT_FOUND`: `baseRevisionId` is not one of the Draft's Revisions, also when the Draft is approved. Both come before every 409.",
    ),
    409: errorResponse(
      "In order of precedence: `DRAFT_APPROVED`: the Draft is approved and accepts no further Revisions. `REVISION_SUPERSEDED`: `baseRevisionId` is no longer the Draft's latest Revision; read the Draft again and build on its latest Revision.",
    ),
    413: errorResponse(PAYLOAD_TOO_LARGE_DESCRIPTION),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

const getRevisionRoute = createRoute({
  method: "get",
  path: "/api/v1/drafts/{draftId}/revisions/{revisionId}",
  operationId: "getRevision",
  tags: ["Drafts"],
  summary: "Get a Revision",
  description:
    "Returns any of the Draft's Revisions, including Superseded ones, with its body and review status.",
  security: AGENT_OR_REVIEWER_SECURITY,
  request: {
    params: revisionParamsSchema,
    headers: readBookmarkRequestHeadersSchema,
  },
  responses: {
    200: {
      description: "The Revision, with its body.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: revisionSchema } },
    },
    400: errorResponse("`INVALID_REQUEST`: an id or a header is malformed; see `issues`."),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    404: errorResponse(
      "`DRAFT_NOT_FOUND`: no Draft has this id. `REVISION_NOT_FOUND`: the Draft has no Revision with this id, including when it is another Draft's Revision.",
    ),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

const submitRevisionRoute = createRoute({
  method: "post",
  path: "/api/v1/drafts/{draftId}/revisions/{revisionId}/submission",
  operationId: "submitRevision",
  tags: ["Drafts"],
  summary: "Submit a Revision for review",
  description:
    "Submits one specific Revision, the Draft's latest and `UNSUBMITTED`, for the Reviewer's verdict; the Revision and the Draft become `PENDING`. Takes no request body. Each Revision is submitted at most once. Revising the Draft afterwards supersedes the Pending Revision, which withdraws its Submission until you submit the new Revision.",
  security: AGENT_OR_REVIEWER_SECURITY,
  request: {
    params: revisionParamsSchema,
    headers: readBookmarkRequestHeadersSchema,
  },
  responses: {
    200: {
      description: "The Pending Draft, without the body.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: draftSummarySchema } },
    },
    400: errorResponse("`INVALID_REQUEST`: an id or a header is malformed; see `issues`."),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    404: errorResponse(
      "`DRAFT_NOT_FOUND`: no Draft has this id. `REVISION_NOT_FOUND`: the Draft has no Revision with this id, including when it is another Draft's Revision.",
    ),
    409: errorResponse(
      "In order of precedence: `DRAFT_APPROVED`: the Draft is approved and accepts no Submission, also of its approved Revision. `REVISION_SUPERSEDED`: the Revision is no longer the Draft's latest; read the Draft again and submit its latest Revision. `REVISION_ALREADY_DECIDED`: the Revision already has a verdict, named in `existingVerdict`; revise the Draft to submit a new Revision. `REVISION_ALREADY_SUBMITTED`: the Revision is already Pending, for example because an earlier attempt of this request went through.",
    ),
    413: errorResponse(NO_BODY_PAYLOAD_TOO_LARGE_DESCRIPTION),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

const listDraftsRoute = createRoute({
  method: "get",
  path: "/api/v1/drafts",
  operationId: "listDrafts",
  tags: ["Drafts"],
  summary: "List Drafts",
  description:
    "Returns one page of Draft summaries, without bodies, filtered by review status and sending status and ordered by `orderBy` and `order`, ties broken by the Draft id. Repeating a filter parameter matches any of its values; different filters must all match. Read further pages by passing `nextCursor` as `cursor` with the same filters and ordering. The Review UI's Pending list is `reviewStatus=PENDING&order=asc` (longest-waiting first); its Decided list is `reviewStatus=APPROVED&reviewStatus=REJECTED` (newest verdict first).",
  security: AGENT_OR_REVIEWER_SECURITY,
  request: {
    query: listDraftsQuerySchema,
    headers: readBookmarkRequestHeadersSchema,
  },
  responses: {
    200: {
      description: "One page of Draft summaries.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: draftListSchema } },
    },
    400: errorResponse(
      "`INVALID_REQUEST`: a parameter is invalid, or `cursor` is malformed or belongs to other filters or another ordering; see `issues`.",
    ),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

const VERDICT_403_DESCRIPTION =
  "`REVIEWER_ONLY`: only the Reviewer token may render a verdict; Agents never can.";

const VERDICT_409_DESCRIPTION =
  "In order of precedence: `REVISION_SUPERSEDED`: the Revision is no longer the Draft's latest; reload the Draft and review its latest Revision. `REVISION_ALREADY_DECIDED`: the Revision already has a verdict, named in `existingVerdict`, also when it is the same verdict again; nothing is recorded twice. `REVISION_NOT_SUBMITTED`: the Revision is `UNSUBMITTED` and awaits no verdict.";

const approveRevisionRoute = createRoute({
  method: "post",
  path: "/api/v1/drafts/{draftId}/revisions/{revisionId}/approval",
  operationId: "approveRevision",
  tags: ["Drafts"],
  summary: "Approve a Revision (Reviewer only)",
  description:
    "Reviewer only. Approves exactly the Revision you loaded, provided it is still the Draft's latest and `PENDING`; takes no request body. The Approval records the Draft's one Send intent: the Draft becomes `APPROVED` with sending status `QUEUED`, accepts no further Revisions or Submissions, and the email (recipients and content of this Revision, sender from configuration) is sent through Resend in the background. A repeated Approval never sends twice: it gets 409 `REVISION_ALREADY_DECIDED`.",
  security: REVIEWER_ONLY_SECURITY,
  request: {
    params: revisionParamsSchema,
    headers: readBookmarkRequestHeadersSchema,
  },
  responses: {
    200: {
      description: "The approved Draft with sending status `QUEUED`, without the body.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: draftSummarySchema } },
    },
    400: errorResponse("`INVALID_REQUEST`: an id or a header is malformed; see `issues`."),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    403: errorResponse(VERDICT_403_DESCRIPTION),
    404: errorResponse(
      "`DRAFT_NOT_FOUND`: no Draft has this id. `REVISION_NOT_FOUND`: the Draft has no Revision with this id, including when it is another Draft's Revision.",
    ),
    409: errorResponse(VERDICT_409_DESCRIPTION),
    413: errorResponse(NO_BODY_PAYLOAD_TOO_LARGE_DESCRIPTION),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

const rejectRevisionRoute = createRoute({
  method: "post",
  path: "/api/v1/drafts/{draftId}/revisions/{revisionId}/rejection",
  operationId: "rejectRevision",
  tags: ["Drafts"],
  summary: "Reject a Revision (Reviewer only)",
  description:
    "Reviewer only. Rejects exactly the Revision you loaded, provided it is still the Draft's latest and `PENDING`, optionally with a reason for the Agent. The request body is optional. The Draft stays open: the Agent can revise it, building on the Rejected Revision, and submit the new Revision; the Draft's `lastVerdict` keeps the reason.",
  security: REVIEWER_ONLY_SECURITY,
  request: {
    params: revisionParamsSchema,
    headers: readBookmarkRequestHeadersSchema,
    body: {
      required: false,
      content: { "application/json": { schema: rejectionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "The rejected Draft, without the body.",
      headers: readBookmarkResponseHeadersSchema,
      content: { "application/json": { schema: draftSummarySchema } },
    },
    400: errorResponse(
      "`INVALID_REQUEST`: the request violates the schema or a limit; see `issues`.",
    ),
    401: errorResponse("`UNAUTHENTICATED`: a valid bearer token is required."),
    403: errorResponse(VERDICT_403_DESCRIPTION),
    404: errorResponse(
      "`DRAFT_NOT_FOUND`: no Draft has this id. `REVISION_NOT_FOUND`: the Draft has no Revision with this id, including when it is another Draft's Revision.",
    ),
    409: errorResponse(VERDICT_409_DESCRIPTION),
    413: errorResponse(PAYLOAD_TOO_LARGE_DESCRIPTION),
    500: errorResponse("`INTERNAL_ERROR`: an unexpected error occurred."),
  },
});

/**
 * The routes only the Reviewer token may call, with Hono routing paths: the API server guards them
 * before any database access. Their OpenAPI security lists only `reviewerAuth`.
 */
export const REVIEWER_ONLY_ROUTES = [approveRevisionRoute, rejectRevisionRoute].map((route) => ({
  method: route.method.toUpperCase(),
  path: route.getRoutingPath(),
}));

/**
 * Creates the OpenAPI app that carries the API contract with the given route handlers and serves
 * its OpenAPI 3.1 document at {@link OPENAPI_DOCUMENT_PATH}. Requests that violate a route's schema
 * get 400 `INVALID_REQUEST` with the violations as `issues`.
 */
export function createApiContractApp<E extends ApiContractEnvironment>(handlers: ApiHandlers<E>) {
  const app = new OpenAPIHono<E>({
    defaultHook: (result, context) => {
      if (result.success) {
        return undefined;
      }

      const body: ErrorResponse = {
        error: {
          code: ERROR_CODE.INVALID_REQUEST,
          message: "The request is invalid; see `issues`.",
          requestId: context.get("requestId"),
          issues: toValidationIssues(result.error.issues),
        },
      };
      return context.json(body, 400);
    },
  });

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
        "Agents create, revise and submit email Drafts; a human Reviewer approves or rejects the submitted Revision in the Review UI, and an Approval sends the email through Resend. Every route except this document requires a bearer token. Errors use the `ErrorResponse` envelope. Send the latest `X-Read-Bookmark` you received on every request to read your own writes.",
    },
  });

  return app
    .openapi(createDraftRoute, handlers.createDraft)
    .openapi(getDraftRoute, handlers.getDraft)
    .openapi(reviseDraftRoute, handlers.reviseDraft)
    .openapi(getRevisionRoute, handlers.getRevision)
    .openapi(submitRevisionRoute, handlers.submitRevision)
    .openapi(listDraftsRoute, handlers.listDrafts)
    .openapi(approveRevisionRoute, handlers.approveRevision)
    .openapi(rejectRevisionRoute, handlers.rejectRevision);
}

function errorResponse(description: string) {
  return {
    description,
    headers: errorResponseHeadersSchema,
    content: { "application/json": { schema: errorResponseSchema } },
  };
}
