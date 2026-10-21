/*
 * The API contract (libs/api.routes) and the domain (libs/drafts) each hold the id patterns: the
 * contract must not depend on the domain. These tests keep the two copies in agreement, so that an
 * id the contract accepts is never one the domain treats as malformed, or the other way round.
 */

import { test } from "vitest";

import { draftParamsSchema, revisionParamsSchema } from "@draft-approval/api.routes";
import { isDraftId, isRevisionId } from "@draft-approval/drafts";

const UUID = "019a0b7e-5c3d-7f2a-9b1e-4d6c8a2f0e13";

test.for(idSamples("drf_"))(
  "the contract and the domain agree that $sample is a Draft id: $isId",
  ({ sample, isId }, { expect }) => {
    expect(draftParamsSchema.shape.draftId.safeParse(sample).success).toBe(isId);
    expect(isDraftId(sample)).toBe(isId);
  },
);

test.for(idSamples("rev_"))(
  "the contract and the domain agree that $sample is a Revision id: $isId",
  ({ sample, isId }, { expect }) => {
    expect(revisionParamsSchema.shape.revisionId.safeParse(sample).success).toBe(isId);
    expect(isRevisionId(sample)).toBe(isId);
  },
);

/** For each prefix: a valid id, then near misses that both copies must reject. */
function idSamples(prefix: "drf_" | "rev_"): { sample: string; isId: boolean }[] {
  const otherPrefix = prefix === "drf_" ? "rev_" : "drf_";
  return [
    { sample: `${prefix}${UUID}`, isId: true },
    { sample: `${otherPrefix}${UUID}`, isId: false },
    { sample: UUID, isId: false },
    { sample: `${prefix}${UUID.toUpperCase()}`, isId: false },
    { sample: `${prefix}${UUID.replaceAll("-", "")}`, isId: false },
    { sample: `${prefix}${UUID.slice(0, -1)}`, isId: false },
    { sample: `${prefix}${UUID}0`, isId: false },
    { sample: `${prefix}${UUID}\n`, isId: false },
    { sample: ` ${prefix}${UUID}`, isId: false },
    { sample: `${prefix}${UUID.replace("0", "g")}`, isId: false },
    { sample: "", isId: false },
  ];
}
