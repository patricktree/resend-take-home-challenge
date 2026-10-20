import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { ListDraftsQuery } from "@draft-approval/api.routes";

import { getApiClient } from "#src/api-client.ts";

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

export function draftQuery(draftId: string) {
  return queryOptions({
    queryKey: [...DRAFTS_QUERY_KEY, "draft", draftId],
    queryFn: () => getApiClient().getDraft(draftId),
  });
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
