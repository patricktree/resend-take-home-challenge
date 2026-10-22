import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiError, ERROR_CODE } from "@resend-challenge/api.client";

import { clearReviewerToken, rejectReviewerToken } from "./reviewer-session.ts";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleUnauthenticated }),
  mutationCache: new MutationCache({ onError: handleUnauthenticated }),
  defaultOptions: {
    queries: {
      // Errors show at once; a 401 in particular must not be retried.
      retry: false,
      // Besides the lists' polling and their Refresh button.
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

/** Signing out forgets the token and everything read with it. */
export function signOut(): void {
  clearReviewerToken();
  queryClient.clear();
}

/**
 * Any `UNAUTHENTICATED` error forgets the token and everything read with it; the app shows the
 * token screen.
 */
function handleUnauthenticated(error: Error): void {
  if (error instanceof ApiError && error.code === ERROR_CODE.UNAUTHENTICATED) {
    rejectReviewerToken();
    queryClient.clear();
  }
}
