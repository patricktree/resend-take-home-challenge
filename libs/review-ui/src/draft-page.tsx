import { css } from "@linaria/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createRoute, type ErrorComponentProps } from "@tanstack/react-router";
import React from "react";

import { ApiError, ERROR_CODE } from "@resend-challenge/api.client";
import type { DraftResponse } from "@resend-challenge/api.routes";

import { assertUnreachable } from "./assert-unreachable.ts";
import { localTimeLabel, reviewStatusLabel, sendingStatusLabel } from "./draft-labels.ts";
import { draftQuery } from "./draft-queries.ts";
import { ErrorMessage } from "./error-message.tsx";
import { rootRoute } from "./root-route.tsx";
import { VerdictControls } from "./verdict-controls.tsx";

type DraftViewProps = {
  draftId: string;
};

type DraftProps = {
  draft: DraftResponse;
};

type ReviewOutcomeProps = DraftProps & {
  onVerdictErrorShownChange: (isShown: boolean) => void;
};

type RejectionLineProps = {
  lead: string;
  reason: string | undefined;
};

type DecidedTimeProps = {
  revision: DraftResponse["latestRevision"];
};

/** The target of every `reviewUrl`. */
export const draftRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drafts/$draftId",
  component: DraftPage,
  errorComponent: DraftPageError,
});

function DraftPage(): React.ReactNode {
  const { draftId } = draftRoute.useParams();
  // Keyed, so another Draft starts without the state of the one before.
  return <DraftView key={draftId} draftId={draftId} />;
}

/** The Draft's latest Revision, with what its review status allows. */
function DraftView({ draftId }: DraftViewProps): React.ReactNode {
  const [isVerdictErrorShown, setIsVerdictErrorShown] = React.useState(false);
  const { data: draft } = useSuspenseQuery({
    ...draftQuery(draftId),
    // A shown verdict error stays until "Reload Draft" clears it (spec section 11, "Verdict
    // errors"): no read on coming back to the tab or online may swap the Revision under it.
    refetchOnWindowFocus: !isVerdictErrorShown,
    refetchOnReconnect: !isVerdictErrorShown,
  });
  const revision = draft.latestRevision;

  return (
    <article className={draftStyles}>
      <h1>{revision.subject}</h1>
      <div>
        <p>To: {revision.to.join(", ")}</p>
        <p>Revision {revision.revisionNumber}</p>
        <p>Status: {reviewStatusLabel(draft.reviewStatus)}</p>
        {revision.submittedAt !== undefined && (
          <p>Submitted: {localTimeLabel(revision.submittedAt)}</p>
        )}
      </div>
      <EarlierRejection draft={draft} />
      <div className={bodyStyles}>{revision.body.plainText}</div>
      <ReviewOutcome draft={draft} onVerdictErrorShownChange={setIsVerdictErrorShown} />
    </article>
  );
}

/** The Draft page's error component, which also catches its query's errors. */
function DraftPageError({ error }: ErrorComponentProps): React.ReactNode {
  if (error instanceof ApiError && error.code === ERROR_CODE.DRAFT_NOT_FOUND) {
    return <p>Draft not found.</p>;
  }
  return <ErrorMessage error={error} />;
}

/** One line above the body when an earlier Revision of the Draft was rejected. */
function EarlierRejection({ draft }: DraftProps): React.ReactNode {
  const { lastVerdict } = draft;
  const isEarlierRejection =
    lastVerdict?.verdict === "REJECTED" && lastVerdict.revisionId !== draft.latestRevision.id;
  if (!isEarlierRejection) {
    return null;
  }

  return (
    <RejectionLine
      lead={`Revision ${lastVerdict.revisionNumber} was rejected`}
      reason={lastVerdict.reason}
    />
  );
}

function ReviewOutcome({ draft, onVerdictErrorShownChange }: ReviewOutcomeProps): React.ReactNode {
  const revision = draft.latestRevision;

  switch (draft.reviewStatus) {
    case "UNSUBMITTED": {
      return <p>Not submitted for review yet.</p>;
    }
    case "PENDING": {
      // Keyed, so a newer Revision gets fresh controls: no reason or error carries over to it.
      return (
        <VerdictControls
          key={revision.id}
          draft={draft}
          onVerdictErrorShownChange={onVerdictErrorShownChange}
        />
      );
    }
    case "APPROVED": {
      return (
        <div>
          <p>{reviewStatusLabel("APPROVED")}</p>
          <DecidedTime revision={revision} />
          <p>{sendingStatusLabel(draft.sending)}</p>
        </div>
      );
    }
    case "REJECTED": {
      return (
        <div>
          <RejectionLine lead={reviewStatusLabel("REJECTED")} reason={revision.rejectionReason} />
          <DecidedTime revision={revision} />
        </div>
      );
    }
    default: {
      return assertUnreachable(draft.reviewStatus);
    }
  }
}

/** A Rejection, followed by its reason when it has one. */
function RejectionLine({ lead, reason }: RejectionLineProps): React.ReactNode {
  return (
    <p>
      {lead}
      {reason !== undefined && (
        <>
          : <em>{reason}</em>
        </>
      )}
    </p>
  );
}

function DecidedTime({ revision }: DecidedTimeProps): React.ReactNode {
  if (revision.decidedAt === undefined) {
    throw new Error("A decided Revision always has a decision time.");
  }
  return <p>Decided: {localTimeLabel(revision.decidedAt)}</p>;
}

const draftStyles = css`
  display: grid;
  gap: calc(2 * var(--spacing-base));
`;

/** The body is plain text: React escapes it, and its line breaks and spaces stay. */
const bodyStyles = css`
  padding: calc(2 * var(--spacing-base));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background-color: var(--color-input-bg);
  border: 1px solid currentcolor;
  border-radius: var(--border-radius-sm);
`;
