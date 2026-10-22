import { css } from "@linaria/core";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import React from "react";
import { Temporal } from "temporal-polyfill";

import type { DraftSummaryResponse } from "@resend-challenge/api.routes";

import { DSButton } from "./design-system/button.tsx";
import {
  localTimeLabel,
  reviewStatusLabel,
  sendingStatusLabel,
  shortRecipientsLabel,
} from "./draft-labels.ts";
import {
  decidedDraftsQuery,
  type DraftListQuery,
  LIST_REFRESH_INTERVAL_MILLISECONDS,
  pendingDraftsQuery,
} from "./draft-queries.ts";
import { ErrorMessage } from "./error-message.tsx";
import { refreshCountdownSeconds } from "./refresh-countdown.ts";
import { rootRoute } from "./root-route.tsx";

type DraftListProps = {
  heading: string;
  emptyText: string;
  listQuery: DraftListQuery;
  columns: DraftColumn[];
};

type DraftColumn = {
  header: string;
  cell: (draft: DraftSummaryResponse) => string;
};

const COLUMN = {
  to: { header: "To", cell: (draft) => shortRecipientsLabel(draft.latestRevision.to) },
  revision: { header: "Revision", cell: (draft) => `Rev. ${draft.latestRevision.revisionNumber}` },
  submitted: {
    header: "Submitted",
    cell: (draft) => optionalTimeLabel(draft.latestRevision.submittedAt),
  },
  verdict: { header: "Verdict", cell: (draft) => reviewStatusLabel(draft.reviewStatus) },
  sending: { header: "Sending", cell: (draft) => sendingStatusLabel(draft.sending) },
  decided: {
    header: "Decided",
    cell: (draft) => optionalTimeLabel(draft.latestRevision.decidedAt),
  },
} satisfies Record<string, DraftColumn>;

export const pendingListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: PendingListPage,
});

export const decidedListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/decided",
  component: DecidedListPage,
});

function PendingListPage(): React.ReactNode {
  return (
    <DraftList
      heading="Pending Drafts"
      emptyText="No Pending Drafts."
      listQuery={pendingDraftsQuery}
      columns={[COLUMN.to, COLUMN.revision, COLUMN.submitted]}
    />
  );
}

function DecidedListPage(): React.ReactNode {
  return (
    <DraftList
      heading="Decided Drafts"
      emptyText="No Decided Drafts."
      listQuery={decidedDraftsQuery}
      columns={[COLUMN.to, COLUMN.revision, COLUMN.verdict, COLUMN.sending, COLUMN.decided]}
    />
  );
}

/** A plain table of Drafts, Subject first; the whole row links to the Draft page. */
function DraftList({ heading, emptyText, listQuery, columns }: DraftListProps): React.ReactNode {
  const headingId = React.useId();
  const list = useSuspenseInfiniteQuery(listQuery);
  const drafts = list.data.pages.flatMap((page) => page.items);

  return (
    <section className={listStyles}>
      <div className={headerStyles}>
        <h1 id={headingId}>{heading}</h1>
        <DSButton
          variant="outlined"
          type="button"
          disabled={list.isFetching}
          onClick={() => void list.refetch()}
        >
          Refresh
        </DSButton>
        <RefreshCountdown dataUpdatedAt={list.dataUpdatedAt} errorUpdatedAt={list.errorUpdatedAt} />
      </div>
      {drafts.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <div className={tableWrapperStyles}>
          <table aria-labelledby={headingId} className={tableStyles}>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                {columns.map((column) => (
                  <th key={column.header} scope="col">
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft) => (
                <tr key={draft.id}>
                  <td>
                    <Link
                      to="/drafts/$draftId"
                      params={{ draftId: draft.id }}
                      className={rowLinkStyles}
                    >
                      {draft.latestRevision.subject}
                    </Link>
                  </td>
                  {columns.map((column) => (
                    <td key={column.header}>{column.cell(draft)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.isFetchNextPageError && <ErrorMessage error={list.error} />}
      {list.hasNextPage && (
        <DSButton
          variant="outlined"
          type="button"
          className={loadMoreStyles}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Load more
        </DSButton>
      )}
    </section>
  );
}

/** Seconds until the list's next automatic refresh, counted from its last read. */
function RefreshCountdown({
  dataUpdatedAt,
  errorUpdatedAt,
}: {
  dataUpdatedAt: number;
  errorUpdatedAt: number;
}): React.ReactNode {
  const [now, setNow] = React.useState(nowEpochMilliseconds);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(nowEpochMilliseconds()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = refreshCountdownSeconds({
    dataUpdatedAt,
    errorUpdatedAt,
    now,
    intervalMilliseconds: LIST_REFRESH_INTERVAL_MILLISECONDS,
  });

  return <span>Next refresh in {seconds} s</span>;
}

function nowEpochMilliseconds(): number {
  return Temporal.Now.instant().epochMilliseconds;
}

function optionalTimeLabel(timestamp: string | undefined): string {
  return timestamp === undefined ? "" : localTimeLabel(timestamp);
}

const listStyles = css`
  display: grid;
  gap: calc(2 * var(--spacing-base));
`;

/** Narrow screens scroll the table sideways rather than the page. */
const tableWrapperStyles = css`
  overflow-x: auto;
`;

const tableStyles = css`
  width: 100%;
  border-collapse: collapse;
  text-align: start;

  & th,
  & td {
    padding-block: var(--spacing-base);
    padding-inline-end: calc(2 * var(--spacing-base));
    text-align: start;
    vertical-align: top;
  }

  & tr {
    border-block-end: 1px solid currentcolor;
  }

  & tbody tr {
    /* containing block of the row link's overlay (rowLinkStyles) */
    position: relative;
  }

  & tbody tr:hover {
    background-color: var(--color-input-bg);
  }
`;

/** Stretches the Subject link over its row, so the whole row is one link named by the subject. */
const rowLinkStyles = css`
  &::after {
    position: absolute;
    inset: 0;
    content: "";
  }
`;

const headerStyles = css`
  display: flex;
  flex-wrap: wrap;
  gap: calc(2 * var(--spacing-base));
  align-items: center;
`;

const loadMoreStyles = css`
  justify-self: start;
`;
