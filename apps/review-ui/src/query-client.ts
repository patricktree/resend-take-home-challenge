import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiError } from "@draft-approval/api.client";

import { clearReviewerToken, rejectReviewerToken } from "#src/reviewer-session.ts";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleUnauthenticated }),
  mutationCache: new MutationCache({ onError: handleUnauthenticated }),
  defaultOptions: {
    queries: {
      // Errors show at once; a 401 in particular must not be retried.
      retry: false,
      // The only refresh of the lists (no polling).
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

/** Any 401 forgets the token and everything read with it; the app shows the token screen. */
function handleUnauthenticated(error: Error): void {
  if (error instanceof ApiError && error.status === 401) {
    rejectReviewerToken();
    queryClient.clear();
  }
}
