import React from "react";

export type ReviewerSession = {
  /** The stored Reviewer token; without one, the app shows the token screen. */
  token: string | undefined;
  /** Whether the API answered 401 to the token that was stored last. */
  wasTokenRejected: boolean;
};

/**
 * `localStorage`, not `sessionStorage`: every `reviewUrl` opens a new tab, which must find the
 * token.
 */
const TOKEN_STORAGE_KEY = "draft-approval.reviewer-token";

const listeners = new Set<() => void>();

let session: ReviewerSession = {
  token: localStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined,
  wasTokenRejected: false,
};

/** Reads the Reviewer session and re-renders when it changes. */
export function useReviewerSession(): ReviewerSession {
  return React.useSyncExternalStore(subscribe, readReviewerSession);
}

export function readReviewerSession(): ReviewerSession {
  return session;
}

/** Stores the token without checking it: the next API request tells whether it is accepted. */
export function storeReviewerToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  updateSession({ token, wasTokenRejected: false });
}

/** Signing out forgets the token. */
export function clearReviewerToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  updateSession({ token: undefined, wasTokenRejected: false });
}

/** Forgets a token the API answered with 401, so the token screen can say so. */
export function rejectReviewerToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  updateSession({ token: undefined, wasTokenRejected: true });
}

function updateSession(nextSession: ReviewerSession): void {
  session = nextSession;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
