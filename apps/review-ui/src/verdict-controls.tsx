import { css, cx } from "@linaria/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React from "react";

import { ApiError } from "@resend-challenge/api.client";
import type { DraftResponse } from "@resend-challenge/api.routes";

import { getApiClient } from "./api-client.ts";
import { DSButton } from "./design-system/button.tsx";
import { textFieldStyles } from "./design-system/text-field.ts";
import { draftQuery, invalidateDraftQueries } from "./draft-queries.ts";
import { ErrorMessage } from "./error-message.tsx";

type VerdictControlsProps = {
  /** A Pending Draft; render the controls keyed by its latest Revision id, so they reset with it. */
  draft: DraftResponse;
  /** Told whether a verdict error shows, so that the Draft page holds still until "Reload Draft". */
  onVerdictErrorShownChange: (isShown: boolean) => void;
};

type Verdict = { kind: "APPROVAL" } | { kind: "REJECTION"; reason: string | undefined };

type VerdictErrorProps = {
  error: Error;
  isBusy: boolean;
  onReloadDraft: () => void;
};

type ExistingVerdict = NonNullable<ApiError["extras"]["existingVerdict"]>;

/** A verdict error with its own message (spec section 11, "Verdict errors"). */
type DescribedVerdictError = {
  message: string;
  canReloadDraft: boolean;
};

/**
 * The API's limit (spec section 6, "Limits and request format"); `libs/api.routes` keeps its own
 * copy unexported, and importing it would put the contract's runtime into the bundle.
 */
const REJECTION_REASON_MAX_LENGTH = 2000;

const ALREADY_DECIDED_MESSAGES: Record<ExistingVerdict, string> = {
  APPROVED: "This Revision was already approved.",
  REJECTED: "This Revision was already rejected.",
};

/**
 * Approve, an optional reason and Reject for the loaded Revision. A failed verdict shows inline
 * above the controls and is never retried: the Reviewer reloads the Draft and decides again.
 */
export function VerdictControls({
  draft,
  onVerdictErrorShownChange,
}: VerdictControlsProps): React.ReactNode {
  const reasonInputId = React.useId();
  const queryClient = useQueryClient();
  const draftId = draft.id;
  // The Revision the Reviewer read: a verdict names it, so it never lands on a newer one.
  const revisionId = draft.latestRevision.id;

  const verdictMutation = useMutation({
    mutationFn: (verdict: Verdict) =>
      verdict.kind === "APPROVAL"
        ? getApiClient().revisions.approve(draftId, revisionId)
        : getApiClient().revisions.reject(
            draftId,
            revisionId,
            verdict.reason === undefined ? {} : { reason: verdict.reason },
          ),
    // Awaited, so the buttons stay disabled until the page shows the refetched Draft.
    onSuccess: () => invalidateDraftQueries(queryClient),
    onError: () => onVerdictErrorShownChange(true),
  });
  const reloadMutation = useMutation({
    mutationFn: () =>
      queryClient.refetchQueries(
        { queryKey: draftQuery(draftId).queryKey, exact: true },
        { throwOnError: true },
      ),
    onSuccess: () => {
      verdictMutation.reset();
      onVerdictErrorShownChange(false);
    },
  });
  const isBusy = verdictMutation.isPending || reloadMutation.isPending;
  // A failed reload replaces the verdict error it was meant to clear.
  const error = reloadMutation.error ?? verdictMutation.error;

  function submitVerdict(verdict: Verdict): void {
    // The error box then shows this verdict's outcome, not an earlier failed reload.
    reloadMutation.reset();
    onVerdictErrorShownChange(false);
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
      kind: "REJECTION",
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
        onClick={() => submitVerdict({ kind: "APPROVAL" })}
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
 * A failed verdict, in a bordered box. `UNAUTHENTICATED` shows nothing here: it clears the token,
 * and the app shows the token screen (query-client.ts).
 */
function VerdictError({ error, isBusy, onReloadDraft }: VerdictErrorProps): React.ReactNode {
  if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
    return null;
  }

  const describedError = describeVerdictError(error);
  return (
    <div className={errorBoxStyles}>
      {describedError === undefined ? (
        <ErrorMessage error={error} />
      ) : (
        <>
          <p role="alert">{describedError.message}</p>
          {describedError.canReloadDraft && (
            <DSButton
              variant="outlined"
              type="button"
              className={buttonStyles}
              disabled={isBusy}
              onClick={onReloadDraft}
            >
              Reload Draft
            </DSButton>
          )}
        </>
      )}
    </div>
  );
}

/** The errors with their own message; any other shows its message and request ID. */
function describeVerdictError(error: Error): DescribedVerdictError | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }

  switch (error.code) {
    case "REVISION_SUPERSEDED": {
      return {
        message: "The Agent changed this Draft after you opened it; your verdict was not recorded.",
        canReloadDraft: true,
      };
    }
    case "REVISION_ALREADY_DECIDED": {
      // Shown even when it is the verdict the Reviewer chose: it came from another tab or person.
      const { existingVerdict } = error.extras;
      // The API always names it (spec section 6); without it, the error shows like any other.
      return existingVerdict === undefined
        ? undefined
        : { message: ALREADY_DECIDED_MESSAGES[existingVerdict], canReloadDraft: true };
    }
    case "REVIEWER_ONLY": {
      return {
        message:
          "The stored token is not the Reviewer token. Sign out and enter the Reviewer token.",
        canReloadDraft: false,
      };
    }
    default: {
      return undefined;
    }
  }
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
