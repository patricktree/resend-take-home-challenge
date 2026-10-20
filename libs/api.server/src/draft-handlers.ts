import type {
  ApiHandlers,
  DraftListResponse,
  DraftResponse,
  DraftSummaryResponse,
  RevisionResponse,
} from "@draft-approval/api.routes";
import { ERROR_CODE } from "@draft-approval/api.routes";
import {
  createDraft,
  getDraft,
  getRevision,
  listDrafts,
  reviseDraft,
  submitRevision,
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

    switch (result.outcome) {
      case "REVISED": {
        return context.json(toDraftSummaryResponse(result.draft, context.env.PUBLIC_BASE_URL), 201);
      }
      case "DRAFT_NOT_FOUND": {
        return jsonError(context, 404, ERROR_CODE.DRAFT_NOT_FOUND, "No Draft has this id.");
      }
      case "REVISION_NOT_FOUND": {
        return jsonError(
          context,
          404,
          ERROR_CODE.REVISION_NOT_FOUND,
          "The Draft has no Revision with the id `baseRevisionId`.",
        );
      }
      case "DRAFT_APPROVED": {
        return jsonError(
          context,
          409,
          ERROR_CODE.DRAFT_APPROVED,
          "The Draft is approved and accepts no further Revisions.",
        );
      }
      case "REVISION_SUPERSEDED": {
        return jsonError(
          context,
          409,
          ERROR_CODE.REVISION_SUPERSEDED,
          "`baseRevisionId` is no longer the Draft's latest Revision; read the Draft again and build on its latest Revision.",
        );
      }
      default: {
        return assertUnreachable(result);
      }
    }
  },

  getRevision: async (context) => {
    const { draftId, revisionId } = context.req.valid("param");
    const result = await getRevision(context.get("draftsStorage"), draftId, revisionId);

    switch (result.outcome) {
      case "FOUND": {
        return context.json(toRevisionResponse(result.revision), 200);
      }
      case "DRAFT_NOT_FOUND": {
        return jsonError(context, 404, ERROR_CODE.DRAFT_NOT_FOUND, "No Draft has this id.");
      }
      case "REVISION_NOT_FOUND": {
        return jsonError(
          context,
          404,
          ERROR_CODE.REVISION_NOT_FOUND,
          "The Draft has no Revision with this id.",
        );
      }
      default: {
        return assertUnreachable(result);
      }
    }
  },

  submitRevision: async (context) => {
    const { draftId, revisionId } = context.req.valid("param");
    const result = await submitRevision(context.get("draftsStorage"), draftId, revisionId);

    switch (result.outcome) {
      case "SUBMITTED": {
        return context.json(toDraftSummaryResponse(result.draft, context.env.PUBLIC_BASE_URL), 200);
      }
      case "DRAFT_NOT_FOUND": {
        return jsonError(context, 404, ERROR_CODE.DRAFT_NOT_FOUND, "No Draft has this id.");
      }
      case "REVISION_NOT_FOUND": {
        return jsonError(
          context,
          404,
          ERROR_CODE.REVISION_NOT_FOUND,
          "The Draft has no Revision with this id.",
        );
      }
      case "DRAFT_APPROVED": {
        return jsonError(
          context,
          409,
          ERROR_CODE.DRAFT_APPROVED,
          "The Draft is approved and accepts no Submission.",
        );
      }
      case "REVISION_SUPERSEDED": {
        return jsonError(
          context,
          409,
          ERROR_CODE.REVISION_SUPERSEDED,
          "The Revision is no longer the Draft's latest; read the Draft again and submit its latest Revision.",
        );
      }
      case "REVISION_ALREADY_DECIDED": {
        return jsonError(
          context,
          409,
          ERROR_CODE.REVISION_ALREADY_DECIDED,
          "The Revision already has a verdict, named in `existingVerdict`; revise the Draft to submit a new Revision.",
          { extras: { existingVerdict: result.existingVerdict } },
        );
      }
      case "REVISION_ALREADY_SUBMITTED": {
        return jsonError(
          context,
          409,
          ERROR_CODE.REVISION_ALREADY_SUBMITTED,
          "The Revision is already submitted and awaits the Reviewer's verdict.",
        );
      }
      default: {
        return assertUnreachable(result);
      }
    }
  },

  listDrafts: async (context) => {
    const { reviewStatus, sendingStatus, orderBy, order, limit, cursor } =
      context.req.valid("query");
    const result = await listDrafts(context.get("draftsStorage"), {
      reviewStatuses: reviewStatus ?? [],
      sendingStatuses: sendingStatus ?? [],
      orderBy,
      order,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });

    switch (result.outcome) {
      case "LISTED": {
        const page: DraftListResponse = {
          items: result.drafts.map((draft) =>
            toDraftSummaryResponse(draft, context.env.PUBLIC_BASE_URL),
          ),
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        };
        return context.json(page, 200);
      }
      case "INVALID_CURSOR": {
        return jsonError(
          context,
          400,
          ERROR_CODE.INVALID_REQUEST,
          "The request is invalid; see `issues`.",
          {
            extras: {
              issues: [
                {
                  path: ["cursor"],
                  message:
                    "Not a cursor of this list: pass a `nextCursor` back with the same filters and ordering it came with.",
                },
              ],
            },
          },
        );
      }
      default: {
        return assertUnreachable(result);
      }
    }
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

/** Fails to compile when a switch misses a case, and throws if an unexpected value arrives anyway. */
function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
