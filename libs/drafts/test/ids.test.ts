import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";

import { createDraftId, createRevisionId } from "../src/ids.ts";

const UUID_V7_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

test.for([
  { name: "Draft", createId: createDraftId, prefix: "drf_" },
  { name: "Revision", createId: createRevisionId, prefix: "rev_" },
])("a $name id is $prefix followed by a UUIDv7", ({ createId, prefix }) => {
  expect(createId()).toMatch(new RegExp(`^${prefix}${UUID_V7_PATTERN}$`));
});

test("a Draft id carries its creation time in its first 48 bits", () => {
  const before = Temporal.Now.instant().epochMilliseconds;
  const draftId = createDraftId();
  const after = Temporal.Now.instant().epochMilliseconds;

  const timestamp = Number.parseInt(
    draftId.slice("drf_".length).replaceAll("-", "").slice(0, 12),
    16,
  );
  expect(timestamp).toBeGreaterThanOrEqual(before);
  expect(timestamp).toBeLessThanOrEqual(after);
});

test("ids created one after the other sort in creation order", () => {
  const draftIds = Array.from({ length: 1000 }, () => createDraftId());
  const revisionIds = Array.from({ length: 1000 }, () => createRevisionId());

  expect(draftIds.toSorted()).toStrictEqual(draftIds);
  expect(revisionIds.toSorted()).toStrictEqual(revisionIds);
  expect(new Set(draftIds).size).toBe(1000);
  expect(new Set(revisionIds).size).toBe(1000);
});
