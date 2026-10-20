import type {
  ApiHandlers,
  DraftResponse,
  DraftSummaryResponse,
  RevisionResponse,
} from "@draft-approval/api.routes";
import { ERROR_CODE } from "@draft-approval/api.routes";
import {
  createDraft,
  getDraft,
  getRevision,
  reviseDraft,
  type Draft,
  type DraftSummary,
  type Revision,
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

  reviseDraft: async (context) => {
    const result = await reviseDraft(
      context.get("draftsStorage"),
      context.req.valid("param").draftId,
      context.req.valid("json"),
    );

    if (result.outcome === "REVISED") {
      return context.json(toDraftSummaryResponse(result.draft, context.env.PUBLIC_BASE_URL), 201);
    }
    if (result.outcome === "DRAFT_NOT_FOUND") {
      return jsonError(context, 404, ERROR_CODE.DRAFT_NOT_FOUND, "No Draft has this id.");
    }
    if (result.outcome === "REVISION_NOT_FOUND") {
      return jsonError(
        context,
        404,
        ERROR_CODE.REVISION_NOT_FOUND,
        "The Draft has no Revision with the id `baseRevisionId`.",
      );
    }
    if (result.outcome === "DRAFT_APPROVED") {
      return jsonError(
        context,
        409,
        ERROR_CODE.DRAFT_APPROVED,
        "The Draft is approved and accepts no further Revisions.",
      );
    }
    // Typed as the one refusal left, so a new refusal fails to compile until it gets its response.
    const refusal: "REVISION_SUPERSEDED" = result.outcome;
    return jsonError(
      context,
      409,
      ERROR_CODE[refusal],
      "`baseRevisionId` is no longer the Draft's latest Revision; read the Draft again and build on its latest Revision.",
    );
  },

  getRevision: async (context) => {
    const { draftId, revisionId } = context.req.valid("param");
    const result = await getRevision(context.get("draftsStorage"), draftId, revisionId);

    if (result.outcome === "FOUND") {
      return context.json(toRevisionResponse(result.revision), 200);
    }
    if (result.outcome === "DRAFT_NOT_FOUND") {
      return jsonError(context, 404, ERROR_CODE.DRAFT_NOT_FOUND, "No Draft has this id.");
    }
    // Typed as the one outcome left, so a new outcome fails to compile until it gets its response.
    const refusal: "REVISION_NOT_FOUND" = result.outcome;
    return jsonError(context, 404, ERROR_CODE[refusal], "The Draft has no Revision with this id.");
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
    latestRevision: toRevisionResponse(draft.latestRevision),
  };
}

function toRevisionResponse(revision: Revision): RevisionResponse {
  return { ...toRevisionSummaryResponse(revision), body: revision.body };
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
