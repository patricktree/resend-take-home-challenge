import type { ApiHandlers, DraftResponse, DraftSummaryResponse } from "@draft-approval/api.routes";
import { ERROR_CODE } from "@draft-approval/api.routes";
import {
  createDraft,
  getDraft,
  type Draft,
  type DraftSummary,
  type RevisionSummary,
} from "@draft-approval/drafts";

import type { ApiServerHonoEnvironment } from "#src/api-server-environment.ts";
import { jsonError } from "#src/http-errors.ts";

export const DRAFT_HANDLERS: ApiHandlers<ApiServerHonoEnvironment> = {
  createDraft: async (context) => {
    const draft = await createDraft(context.get("draftsStorage"), context.req.valid("json"));

    return context.json(toDraftSummaryResponse(draft, context.env.PUBLIC_BASE_URL), 201);
  },

  getDraft: async (context) => {
    const draft = await getDraft(context.get("draftsStorage"), context.req.valid("param").draftId);
    if (draft === undefined) {
      return jsonError(context, 404, ERROR_CODE.DRAFT_NOT_FOUND, "No Draft has this id.");
    }

    return context.json(toDraftResponse(draft, context.env.PUBLIC_BASE_URL), 200);
  },
};

function toDraftSummaryResponse(draft: DraftSummary, publicBaseUrl: string): DraftSummaryResponse {
  return {
    id: draft.id,
    createdAt: toTimestamp(draft.createdAt),
    lastActionAt: toTimestamp(draft.lastActionAt),
    reviewStatus: toDraftReviewStatus(draft.latestRevision),
    latestRevision: toRevisionSummaryResponse(draft.latestRevision),
    sending: draft.sending,
    reviewUrl: new URL(`/app/drafts/${draft.id}`, publicBaseUrl).href,
  };
}

function toDraftResponse(draft: Draft, publicBaseUrl: string): DraftResponse {
  return {
    ...toDraftSummaryResponse(draft, publicBaseUrl),
    latestRevision: {
      ...toRevisionSummaryResponse(draft.latestRevision),
      body: draft.latestRevision.body,
    },
  };
}

function toRevisionSummaryResponse(
  revision: RevisionSummary,
): DraftSummaryResponse["latestRevision"] {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    createdAt: toTimestamp(revision.createdAt),
    to: revision.to,
    subject: revision.subject,
    reviewStatus: revision.reviewStatus,
    ...(revision.submittedAt === undefined
      ? {}
      : { submittedAt: toTimestamp(revision.submittedAt) }),
    ...(revision.decidedAt === undefined ? {} : { decidedAt: toTimestamp(revision.decidedAt) }),
    ...(revision.rejectionReason === undefined
      ? {}
      : { rejectionReason: revision.rejectionReason }),
  };
}

/** API timestamps are ISO 8601 UTC with milliseconds, for example `2026-10-20T09:30:00.000Z`. */
function toTimestamp(instant: Draft["createdAt"]): string {
  return instant.toString({ fractionalSecondDigits: 3 });
}

/** A Draft's review status is its latest Revision's; the latest Revision is never Superseded. */
function toDraftReviewStatus(
  latestRevision: RevisionSummary,
): DraftSummaryResponse["reviewStatus"] {
  if (latestRevision.reviewStatus === "SUPERSEDED") {
    throw new Error(`The latest Revision ${latestRevision.id} is SUPERSEDED.`);
  }
  return latestRevision.reviewStatus;
}
