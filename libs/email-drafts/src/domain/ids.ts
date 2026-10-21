/*
 * Prefixed UUIDv7 ids: they sort by creation time, and the prefix keeps an Agent from mixing up the
 * Draft id and the Revision id that every Submission names.
 */

import { v7 as uuidv7 } from "uuid";

/** A Draft id: `drf_` followed by a UUIDv7. */
export type DraftId = `drf_${string}`;

/** A Revision id: `rev_` followed by a UUIDv7. */
export type RevisionId = `rev_${string}`;

const DRAFT_ID_PATTERN = /^drf_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REVISION_ID_PATTERN = /^rev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createDraftId(): DraftId {
  return `drf_${uuidv7()}`;
}

export function createRevisionId(): RevisionId {
  return `rev_${uuidv7()}`;
}

export function isDraftId(value: string): value is DraftId {
  return DRAFT_ID_PATTERN.test(value);
}

export function isRevisionId(value: string): value is RevisionId {
  return REVISION_ID_PATTERN.test(value);
}
