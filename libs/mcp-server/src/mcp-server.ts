import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { ApiError, type ApiClient } from "@resend-challenge/api.client";
import {
  draftDataRequestSchema,
  draftListSchema,
  draftParamsSchema,
  draftReviewStatusSchema,
  draftSchema,
  draftSummarySchema,
  listDraftsQuerySchema,
  OPENAPI_DOCUMENT_PATH,
  reviseRequestSchema,
  revisionParamsSchema,
  revisionSchema,
  sendingStatusSchema,
} from "@resend-challenge/api.routes";

export type ResendChallengeMcpServerOptions = {
  /**
   * The typed client every tool calls the API through. It carries the caller's own token, so a tool
   * call passes the same authentication, authorization and validation as an HTTP call.
   */
  client: ApiClient;
  /** The origin of the deployed Worker, which the instructions link the OpenAPI document under. */
  publicBaseUrl: string;
};

const READ_ONLY = { readOnlyHint: true } as const;

/**
 * The parameters of `list_drafts`. The list query of the API is shaped for a query string (a
 * repeated parameter arrives as a string or an array), so the two filters are plain arrays here.
 */
const listDraftsInputSchema = z.strictObject({
  reviewStatus: z
    .array(draftReviewStatusSchema)
    .optional()
    .describe("Only Drafts with one of these review statuses, the latest Revision's."),
  sendingStatus: z
    .array(sendingStatusSchema)
    .optional()
    .describe("Only Drafts with one of these sending statuses."),
  orderBy: listDraftsQuerySchema.shape.orderBy,
  order: listDraftsQuerySchema.shape.order,
  limit: listDraftsQuerySchema.shape.limit,
  cursor: listDraftsQuerySchema.shape.cursor,
});

const reviseDraftInputSchema = z.strictObject({
  ...draftParamsSchema.shape,
  ...reviseRequestSchema.shape,
});

/**
 * Creates the MCP server with the six Agent tools, each on one operation of the typed client. There
 * is deliberately no verdict tool: only the Reviewer approves or rejects, in the Review UI.
 *
 * `createMcpHandler` asks for a fresh server per request, so this is cheap and keeps no state.
 */
export function createResendChallengeMcpServer({
  client,
  publicBaseUrl,
}: ResendChallengeMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "resend-challenge", version: "1.0.0" },
    { instructions: describeInstructions(publicBaseUrl) },
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create a Draft",
      description:
        "Creates a Draft whose first Revision holds the given recipients, subject and plain-text body, UNSUBMITTED. Creating never submits: call submit_draft with the returned `latestRevision.id` next. Not idempotent: a retried call may create a second Draft.",
      inputSchema: draftDataRequestSchema,
      outputSchema: draftSummarySchema,
    },
    (draftData) => runAsToolResult(() => client.createDraft(draftData)),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Get a Draft",
      description:
        "Returns the Draft with its latest Revision, including the body. Poll it after submitting: `reviewStatus` (PENDING, APPROVED, REJECTED), `lastVerdict` (with the Rejection reason) and `sending.status` (NOT_SENT, QUEUED, SENT, FAILED) tell where the Draft stands.",
      inputSchema: draftParamsSchema,
      outputSchema: draftSchema,
      annotations: READ_ONLY,
    },
    ({ draftId }) => runAsToolResult(() => client.getDraft(draftId)),
  );

  server.registerTool(
    "list_drafts",
    {
      title: "List Drafts",
      description:
        "Returns one page of Draft summaries, without bodies, filtered by review status and sending status and ordered by `orderBy` and `order`. Read further pages by passing `nextCursor` as `cursor` with the same filters and ordering.",
      inputSchema: listDraftsInputSchema,
      outputSchema: draftListSchema,
      annotations: READ_ONLY,
    },
    (query) => runAsToolResult(() => client.listDrafts(query)),
  );

  server.registerTool(
    "revise_draft",
    {
      title: "Revise a Draft",
      description:
        "Creates the Draft's next Revision, UNSUBMITTED, from the given recipients, subject and body. `baseRevisionId` is the Draft's latest Revision as you last read it; if another revise came first, nothing is written and the result is the error REVISION_SUPERSEDED: read the Draft again and build on its latest Revision. Revising withdraws a pending Submission. It never submits: call submit_draft with the new `latestRevision.id`. An approved Draft accepts no further Revisions (DRAFT_APPROVED).",
      inputSchema: reviseDraftInputSchema,
      outputSchema: draftSummarySchema,
    },
    ({ draftId, ...reviseRequest }) =>
      runAsToolResult(() => client.reviseDraft(draftId, reviseRequest)),
  );

  server.registerTool(
    "submit_draft",
    {
      title: "Submit a Revision for review",
      description:
        "Submits one specific Revision, the Draft's latest and UNSUBMITTED, for the human Reviewer's verdict; the Draft becomes PENDING. The Reviewer reviews it at the Draft's `reviewUrl`; poll get_draft for the verdict. Errors: DRAFT_APPROVED, REVISION_SUPERSEDED (submit the latest Revision instead), REVISION_ALREADY_DECIDED with `existingVerdict` (revise the Draft first), REVISION_ALREADY_SUBMITTED (an earlier attempt went through).",
      inputSchema: revisionParamsSchema,
      outputSchema: draftSummarySchema,
    },
    ({ draftId, revisionId }) => runAsToolResult(() => client.submitRevision(draftId, revisionId)),
  );

  server.registerTool(
    "get_revision",
    {
      title: "Get a Revision",
      description:
        "Returns any of the Draft's Revisions, including Superseded ones, with its body and review status.",
      inputSchema: revisionParamsSchema,
      outputSchema: revisionSchema,
      annotations: READ_ONLY,
    },
    ({ draftId, revisionId }) => runAsToolResult(() => client.getRevision(draftId, revisionId)),
  );

  return server;
}

function describeInstructions(publicBaseUrl: string): string {
  const openApiDocumentUrl = new URL(OPENAPI_DOCUMENT_PATH, publicBaseUrl).href;

  return [
    "Email Draft Approval: you compose email Drafts; a human Reviewer approves or rejects each one before anything is sent.",
    "",
    "Lifecycle:",
    "1. create_draft creates a Draft whose first Revision is UNSUBMITTED.",
    "2. submit_draft submits one specific Revision (the Draft's latest) for review; the Draft becomes PENDING.",
    "3. A human Reviewer reads exactly that Revision at the Draft's `reviewUrl` and approves or rejects it. An Approval sends the email through Resend, with no further action by anyone.",
    "4. Poll get_draft for `reviewStatus`, `lastVerdict` (with the Rejection reason) and `sending` (NOT_SENT, QUEUED, SENT or FAILED).",
    "",
    "Agents cannot approve, reject or send: no tool does that, and none will. A rejected Draft is revised with revise_draft, passing its latest Revision's id as `baseRevisionId`, and the new Revision is submitted again with submit_draft. An approved Draft accepts no further Revisions.",
    "",
    "A failed call is a tool error whose structured content is `{ error: { code, message, requestId, ... } }`, with the API's error codes, for example REVISION_SUPERSEDED.",
    "",
    `The HTTP API behind these tools is described by its OpenAPI document: ${openApiDocumentUrl}`,
  ].join("\n");
}

/**
 * Runs one API call and answers with its response as structured content, plus a text block with the
 * same JSON for hosts that ignore structured content. An error response of the API becomes a tool
 * error carrying its code, message, request id and extras (such as `existingVerdict`).
 */
async function runAsToolResult(
  call: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    const response = await call();
    return toToolResult(response, { isError: false });
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    const toolError = {
      error: {
        code: error.code,
        message: error.message,
        requestId: error.requestId,
        ...error.extras,
      },
    };
    return toToolResult(toolError, { isError: true });
  }
}

function toToolResult(
  structuredContent: Record<string, unknown>,
  { isError }: { isError: boolean },
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError } : {}),
  };
}
