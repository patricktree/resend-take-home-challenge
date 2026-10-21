import { infiniteQueryOptions, type QueryClient, queryOptions } from "@tanstack/react-query";

import type { ListDraftsQuery } from "@resend-challenge/api.routes";

import { getApiClient } from "./api-client.ts";

/** The query of one of the two lists, Pending or Decided. */
export type DraftListQuery = ReturnType<typeof createDraftListQuery>;

/** Every query key starts with this, so a verdict can invalidate the Draft and both lists at once. */
const DRAFTS_QUERY_KEY = ["drafts"] as const;

/** Longest-waiting first: a Pending Draft's last action is its Submission. */
const PENDING_LIST_QUERY: ListDraftsQuery = { reviewStatus: ["PENDING"], order: "asc" };

/** Newest decision first (the API's default ordering). */
const DECIDED_LIST_QUERY: ListDraftsQuery = { reviewStatus: ["APPROVED", "REJECTED"] };

export const pendingDraftsQuery = createDraftListQuery("pending", PENDING_LIST_QUERY);

export const decidedDraftsQuery = createDraftListQuery("decided", DECIDED_LIST_QUERY);

/** How often the Draft page reads the Draft again while its Send is `QUEUED`. */
const SENDING_POLL_INTERVAL_MILLISECONDS = 3000;

export function draftQuery(draftId: string) {
  return queryOptions({
    queryKey: [...DRAFTS_QUERY_KEY, "draft", draftId],
    queryFn: () => getApiClient().getDraft(draftId),
    // Polls until the Send leaves `QUEUED` ("Sending…"), then stops.
    refetchInterval: (query) =>
      query.state.data?.sending.status === "QUEUED" ? SENDING_POLL_INTERVAL_MILLISECONDS : false,
  });
}

/** After a verdict: the Draft and both lists read again (the lists once they are shown). */
export function invalidateDraftQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: DRAFTS_QUERY_KEY });
}

function createDraftListQuery(listName: string, listQuery: ListDraftsQuery) {
  return infiniteQueryOptions({
    queryKey: [...DRAFTS_QUERY_KEY, "list", listName],
    queryFn: ({ pageParam }) =>
      getApiClient().listDrafts({
        ...listQuery,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}
