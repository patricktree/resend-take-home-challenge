import { css, cx } from "@linaria/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React from "react";

import { ApiError } from "@draft-approval/api.client";
import type { DraftResponse } from "@draft-approval/api.routes";

import { getApiClient } from "#src/api-client.ts";
import { DSButton } from "#src/design-system/button.tsx";
import { textFieldStyles } from "#src/design-system/text-field.ts";
import { invalidateDraftQueries } from "#src/draft-queries.ts";
import { ErrorMessage } from "#src/error-message.tsx";

type VerdictControlsProps = {
  /** A Pending Draft; render the controls keyed by its latest Revision id, so they reset with it. */
  draft: DraftResponse;
  /** Reads the Draft again and rejects when that fails. */
  reloadDraft: () => Promise<unknown>;
};

type Verdict = { verdict: "APPROVED" } | { verdict: "REJECTED"; reason: string | undefined };

type VerdictErrorProps = {
  error: Error;
  isBusy: boolean;
  onReloadDraft: () => void;
};

type ExistingVerdict = NonNullable<ApiError["extras"]["existingVerdict"]>;

/** The API's limit (spec section 6, "Limits and request format"). */
const REJECTION_REASON_MAX_LENGTH = 2000;

const ALREADY_DECIDED_MESSAGES: Record<ExistingVerdict, string> = {
  APPROVED: "This Revision was already approved.",
  REJECTED: "This Revision was already rejected.",
};

/**
 * Approve, an optional reason and Reject for the loaded Revision. A failed verdict shows inline
 * above the controls and is never retried: the Reviewer reloads the Draft and decides again.
 */
export function VerdictControls({ draft, reloadDraft }: VerdictControlsProps): React.ReactNode {
  const reasonInputId = React.useId();
  const queryClient = useQueryClient();
  const draftId = draft.id;
  // The Revision the Reviewer read: a verdict names it, so it never lands on a newer one.
  const revisionId = draft.latestRevision.id;

  const verdictMutation = useMutation({
    mutationFn: (verdict: Verdict) =>
      verdict.verdict === "APPROVED"
        ? getApiClient().approveRevision(draftId, revisionId)
        : getApiClient().rejectRevision(
            draftId,
            revisionId,
            verdict.reason === undefined ? {} : { reason: verdict.reason },
          ),
    // Awaited, so the buttons stay disabled until the page shows the refetched Draft.
    onSuccess: () => invalidateDraftQueries(queryClient),
  });
  const reloadMutation = useMutation({
    mutationFn: reloadDraft,
    onSuccess: () => verdictMutation.reset(),
  });
  const isBusy = verdictMutation.isPending || reloadMutation.isPending;
  // A failed reload replaces the verdict error it was meant to clear.
  const error = reloadMutation.error ?? verdictMutation.error;

  function submitVerdict(verdict: Verdict): void {
    // The error box then shows this verdict's outcome, not an earlier failed reload.
    reloadMutation.reset();
    verdictMutation.mutate(verdict);
  }

  function handleRejectionSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get("reason");
    if (typeof reason !== "string") {
      throw new TypeError("The rejection form has no `reason` field.");
    }

    // The API trims the reason too; an empty one counts as none.
    const trimmedReason = reason.trim();
    submitVerdict({
      verdict: "REJECTED",
      reason: trimmedReason === "" ? undefined : trimmedReason,
    });
  }

  return (
    <div className={controlsStyles}>
      {error !== null && (
        <VerdictError error={error} isBusy={isBusy} onReloadDraft={() => reloadMutation.mutate()} />
      )}
      <DSButton
        variant="contained"
        type="button"
        className={buttonStyles}
        disabled={isBusy}
        onClick={() => submitVerdict({ verdict: "APPROVED" })}
      >
        Approve
      </DSButton>
      <form className={rejectionFormStyles} onSubmit={handleRejectionSubmit}>
        <label htmlFor={reasonInputId}>Reason for rejection</label>
        <textarea
          id={reasonInputId}
          className={cx(textFieldStyles, reasonInputStyles)}
          name="reason"
          rows={3}
          maxLength={REJECTION_REASON_MAX_LENGTH}
        />
        <DSButton variant="outlined" type="submit" className={buttonStyles} disabled={isBusy}>
          Reject
        </DSButton>
      </form>
    </div>
  );
}

/**
 * A failed verdict, in a bordered box. A 401 shows nothing here: it clears the token, and the app
 * shows the token screen (query-client.ts).
 */
function VerdictError({ error, isBusy, onReloadDraft }: VerdictErrorProps): React.ReactNode {
  if (error instanceof ApiError && error.status === 401) {
    return null;
  }

  const reloadButton = (
    <DSButton
      variant="outlined"
      type="button"
      className={buttonStyles}
      disabled={isBusy}
      onClick={onReloadDraft}
    >
      Reload Draft
    </DSButton>
  );

  let content: React.ReactNode;
  if (error instanceof ApiError && error.code === "REVISION_SUPERSEDED") {
    content = (
      <>
        <p role="alert">
          The Agent changed this Draft after you opened it; your verdict was not recorded.
        </p>
        {reloadButton}
      </>
    );
  } else if (error instanceof ApiError && error.code === "REVISION_ALREADY_DECIDED") {
    // Shown even when it is the verdict the Reviewer chose: someone else may have rendered it.
    content = (
      <>
        <p role="alert">{ALREADY_DECIDED_MESSAGES[readExistingVerdict(error)]}</p>
        {reloadButton}
      </>
    );
  } else if (error instanceof ApiError && error.code === "REVIEWER_ONLY") {
    content = (
      <p role="alert">
        The stored token is not the Reviewer token. Sign out and enter the Reviewer token.
      </p>
    );
  } else {
    content = <ErrorMessage error={error} />;
  }

  return <div className={errorBoxStyles}>{content}</div>;
}

function readExistingVerdict(error: ApiError): ExistingVerdict {
  const { existingVerdict } = error.extras;
  if (existingVerdict === undefined) {
    throw new Error(
      `The API answered REVISION_ALREADY_DECIDED without \`existingVerdict\` (request ID ${error.requestId}).`,
    );
  }
  return existingVerdict;
}

const controlsStyles = css`
  display: grid;
  gap: calc(2 * var(--spacing-base));
`;

const rejectionFormStyles = css`
  display: grid;
  gap: var(--spacing-base);
`;

const reasonInputStyles = css`
  resize: vertical;
`;

const buttonStyles = css`
  justify-self: start;
`;

const errorBoxStyles = css`
  display: grid;
  gap: var(--spacing-base);
  padding: calc(2 * var(--spacing-base));
  border: 1px solid currentcolor;
  border-radius: var(--border-radius-sm);
`;
