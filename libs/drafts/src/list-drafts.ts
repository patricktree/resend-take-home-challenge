/*
 * Lists Drafts with keyset paging (spec section 6, "Lists"). The query walks the
 * `(created_at, id)` or `(last_action_at, id)` index from the cursor's position, so a page costs
 * the same however deep it is, and it never reads R2: list items are Draft summaries.
 */

import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import buffer from "node:buffer";

import type { DraftsStorage } from "./database.ts";
import { toDraftSummary } from "./draft-rows.ts";
import type { DraftSummary } from "./draft.ts";
import { isDraftId, type DraftId } from "./ids.ts";
import { drafts, revisions, type ReviewStatus, type SendingStatus } from "./schema.ts";

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

/** Each ordering's column, and how to read its value from a Draft row. */
const ORDERINGS = {
  createdAt: {
    column: drafts.createdAt,
    valueOf: (row: typeof drafts.$inferSelect) => row.createdAt,
  },
  lastActionAt: {
    column: drafts.lastActionAt,
    valueOf: (row: typeof drafts.$inferSelect) => row.lastActionAt,
  },
} as const;

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

  const ordering = ORDERINGS[query.orderBy];
  const orderDirection = query.order === "asc" ? asc : desc;
  const conditions: SQL[] = [];
  // Each value is bound once, however often a client repeats it: D1 binds at most 100 parameters
  // per query, and the statuses are only a few.
  if (query.reviewStatuses.length > 0) {
    conditions.push(inArray(revisions.reviewStatus, [...new Set(query.reviewStatuses)]));
  }
  if (query.sendingStatuses.length > 0) {
    conditions.push(inArray(drafts.sendingStatus, [...new Set(query.sendingStatuses)]));
  }
  if (position !== undefined) {
    // A row-value comparison, which SQLite answers with a range scan of the `(…, id)` index.
    const comparison = query.order === "asc" ? sql.raw(">") : sql.raw("<");
    conditions.push(
      sql`(${ordering.column}, ${drafts.id}) ${comparison} (${position.orderingValue}, ${position.draftId})`,
    );
  }

  // One row more than the page tells whether another page follows.
  const rows = await database
    .select()
    .from(drafts)
    .innerJoin(revisions, eq(revisions.id, drafts.latestRevisionId))
    .where(and(...conditions))
    .orderBy(orderDirection(ordering.column), orderDirection(drafts.id))
    .limit(query.limit + 1);

  const pageRows = rows.slice(0, query.limit);
  const lastRow = pageRows.at(-1);
  const hasNextPage = rows.length > query.limit && lastRow !== undefined;
  const lastVerdictRows = await readLastVerdictRows(
    database,
    pageRows.map((row) => row.revisions),
  );

  return {
    outcome: "LISTED",
    drafts: pageRows.map((row) =>
      toDraftSummary(row.drafts, row.revisions, lastVerdictRows.get(row.drafts.id)),
    ),
    ...(hasNextPage
      ? {
          nextCursor: encodeCursor({
            orderingValue: ordering.valueOf(lastRow.drafts),
            draftId: lastRow.drafts.id,
            queryFingerprint,
          }),
        }
      : {}),
  };
}

/**
 * Reads the last verdict of each listed Draft, by Draft id, with one query for the whole page.
 *
 * It runs after the page query, so a verdict committed in between could show up next to the
 * still-Pending latest Revision of the page. Only the latest Revision can get a verdict, so a
 * verdict on an earlier Revision is final; the latest Revision's own verdict comes from the page's
 * row, which keeps each item consistent.
 */
async function readLastVerdictRows(
  database: DraftsStorage["database"],
  latestRevisionRows: (typeof revisions.$inferSelect)[],
): Promise<Map<DraftId, typeof revisions.$inferSelect>> {
  const lastVerdictRows = new Map<DraftId, typeof revisions.$inferSelect>();
  if (latestRevisionRows.length === 0) {
    return lastVerdictRows;
  }

  const earlierVerdictRows = await database
    .select()
    .from(revisions)
    .where(
      and(
        inArray(
          revisions.draftId,
          latestRevisionRows.map((row) => row.draftId),
        ),
        isNotNull(revisions.decidedAt),
      ),
    )
    .orderBy(asc(revisions.revisionNumber));
  const latestRevisionNumbers = new Map(
    latestRevisionRows.map((row) => [row.draftId, row.revisionNumber]),
  );
  for (const row of earlierVerdictRows) {
    const latestRevisionNumber = latestRevisionNumbers.get(row.draftId);
    // Ascending order: a later Revision's verdict replaces an earlier one's.
    if (latestRevisionNumber !== undefined && row.revisionNumber < latestRevisionNumber) {
      lastVerdictRows.set(row.draftId, row);
    }
  }
  for (const row of latestRevisionRows) {
    if (row.decidedAt !== null) {
      lastVerdictRows.set(row.draftId, row);
    }
  }

  return lastVerdictRows;
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
  // Decoding skips characters outside the base64url alphabet, so only a cursor that encodes back
  // to itself is one this module issued.
  const bytes = buffer.Buffer.from(encodedCursor, "base64url");
  if (bytes.toString("base64url") !== encodedCursor) {
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
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
