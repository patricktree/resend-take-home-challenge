/*
 * Lists Drafts with keyset paging (spec section 6, "Lists"). The query walks the
 * `(created_at, id)` or `(last_action_at, id)` index from the cursor's position, so a page costs
 * the same however deep it is, and it never reads R2: list items are Draft summaries.
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import buffer from "node:buffer";

import type { DraftsStorage } from "#src/database.ts";
import { toDraftSummary, type DraftSummary } from "#src/draft.ts";
import { isDraftId, type DraftId } from "#src/ids.ts";
import { drafts, revisions, type ReviewStatus, type SendingStatus } from "#src/schema.ts";

/** A Draft's review status is its latest Revision's, which is never Superseded. */
type DraftReviewStatus = Exclude<ReviewStatus, "SUPERSEDED">;

export type ListDraftsQuery = {
  /** Matches any of these; an empty list matches every review status. */
  reviewStatuses: readonly DraftReviewStatus[];
  /** Matches any of these; an empty list matches every sending status. */
  sendingStatuses: readonly SendingStatus[];
  orderBy: "createdAt" | "lastActionAt";
  order: "asc" | "desc";
  limit: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
};

export type ListDraftsResult =
  | { outcome: "LISTED"; drafts: DraftSummary[]; nextCursor?: string }
  /** The cursor does not decode, or it belongs to other filters or another ordering. */
  | { outcome: "INVALID_CURSOR" };

/** Where a page ends: the ordering value and id of its last Draft. */
type CursorPosition = { orderingValue: number; draftId: DraftId };

type Cursor = CursorPosition & {
  /** The normalized filters and ordering the cursor was issued for. */
  queryFingerprint: string;
};

/**
 * Reads one page of Draft summaries, filtered by the latest Revision's review status and by the
 * sending status, ordered by the ordering value and then by id in the same direction.
 */
export async function listDrafts(
  { database }: DraftsStorage,
  query: ListDraftsQuery,
): Promise<ListDraftsResult> {
  const queryFingerprint = fingerprintQuery(query);

  let position: CursorPosition | undefined;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    if (cursor === undefined || cursor.queryFingerprint !== queryFingerprint) {
      return { outcome: "INVALID_CURSOR" };
    }
    position = cursor;
  }

  const orderingColumn = query.orderBy === "createdAt" ? drafts.createdAt : drafts.lastActionAt;
  const orderDirection = query.order === "asc" ? asc : desc;
  const conditions: SQL[] = [];
  if (query.reviewStatuses.length > 0) {
    conditions.push(inArray(revisions.reviewStatus, [...query.reviewStatuses]));
  }
  if (query.sendingStatuses.length > 0) {
    conditions.push(inArray(drafts.sendingStatus, [...query.sendingStatuses]));
  }
  if (position !== undefined) {
    // A row-value comparison, which SQLite answers with a range scan of the `(…, id)` index.
    const comparison = query.order === "asc" ? sql.raw(">") : sql.raw("<");
    conditions.push(
      sql`(${orderingColumn}, ${drafts.id}) ${comparison} (${position.orderingValue}, ${position.draftId})`,
    );
  }

  // One row more than the page tells whether another page follows.
  const rows = await database
    .select()
    .from(drafts)
    .innerJoin(revisions, eq(revisions.id, drafts.latestRevisionId))
    .where(and(...conditions))
    .orderBy(orderDirection(orderingColumn), orderDirection(drafts.id))
    .limit(query.limit + 1);

  const pageRows = rows.slice(0, query.limit);
  const lastRow = pageRows.at(-1);
  const hasNextPage = rows.length > query.limit && lastRow !== undefined;

  return {
    outcome: "LISTED",
    drafts: pageRows.map((row) => toDraftSummary(row.drafts, row.revisions)),
    ...(hasNextPage
      ? {
          nextCursor: encodeCursor({
            orderingValue:
              query.orderBy === "createdAt"
                ? lastRow.drafts.createdAt
                : lastRow.drafts.lastActionAt,
            draftId: lastRow.drafts.id,
            queryFingerprint,
          }),
        }
      : {}),
  };
}

/**
 * The filters and ordering in a canonical form: the same filter values in another order or repeated
 * give the same fingerprint. `limit` is left out, so it may change between pages.
 */
function fingerprintQuery(query: ListDraftsQuery): string {
  return JSON.stringify([
    [...new Set(query.reviewStatuses)].toSorted(),
    [...new Set(query.sendingStatuses)].toSorted(),
    query.orderBy,
    query.order,
  ]);
}

/** A cursor is base64url of a small JSON array, opaque to clients. */
function encodeCursor({ orderingValue, draftId, queryFingerprint }: Cursor): string {
  const json = JSON.stringify([orderingValue, draftId, queryFingerprint]);
  return buffer.Buffer.from(json, "utf8").toString("base64url");
}

/** Decodes a cursor; `undefined` when it is not one this module issued. */
function decodeCursor(encodedCursor: string): Cursor | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(buffer.Buffer.from(encodedCursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }

  if (!Array.isArray(decoded) || decoded.length !== 3) {
    return undefined;
  }
  const [orderingValue, draftId, queryFingerprint]: unknown[] = decoded;
  if (
    typeof orderingValue !== "number" ||
    !Number.isSafeInteger(orderingValue) ||
    typeof draftId !== "string" ||
    !isDraftId(draftId) ||
    typeof queryFingerprint !== "string"
  ) {
    return undefined;
  }
  return { orderingValue, draftId, queryFingerprint };
}
