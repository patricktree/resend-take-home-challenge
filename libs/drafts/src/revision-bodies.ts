/*
 * Every Revision's body is one JSON object in R2, written once before the D1 write that creates the
 * Revision. Revisions are immutable, so the object never changes; a failed D1 write leaves an
 * orphaned object that nothing references.
 */

import type { RevisionBody } from "#src/draft.ts";
import type { RevisionId } from "#src/ids.ts";

export async function putRevisionBody(
  revisionBodies: R2Bucket,
  revisionId: RevisionId,
  body: RevisionBody,
): Promise<void> {
  await revisionBodies.put(revisionBodyKey(revisionId), JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Reads a Revision's body; throws when it is missing, since every Revision row has one. */
export async function getRevisionBody(
  revisionBodies: R2Bucket,
  revisionId: RevisionId,
): Promise<RevisionBody> {
  return getRevisionBodyAt(revisionBodies, revisionBodyKey(revisionId));
}

/**
 * Reads the Revision body at an R2 key, such as the `bodyKey` of a frozen outgoing email; throws
 * when it is missing.
 */
export async function getRevisionBodyAt(
  revisionBodies: R2Bucket,
  bodyKey: string,
): Promise<RevisionBody> {
  const object = await revisionBodies.get(bodyKey);
  if (object === null) {
    throw new Error(`The Revision body ${bodyKey} is missing from R2.`);
  }

  const body: unknown = await object.json();
  if (!isRevisionBody(body)) {
    throw new Error(`The Revision body ${bodyKey} in R2 is not a Revision body.`);
  }
  return body;
}

/** The R2 key of a Revision's body. */
export function revisionBodyKey(revisionId: RevisionId): string {
  return `revisions/${revisionId}/body`;
}

function isRevisionBody(value: unknown): value is RevisionBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "plainText" in value &&
    typeof value.plainText === "string"
  );
}
