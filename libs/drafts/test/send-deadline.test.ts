import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";

import { computeSendDeadline, isPastSendDeadline } from "../src/send-deadline.ts";

test("the deadline of a Send is 23 h after its Approval", () => {
  const approvedAt = Temporal.Instant.from("2026-10-21T08:15:30.250Z");

  expect(computeSendDeadline(approvedAt)).toBe(
    Temporal.Instant.from("2026-10-22T07:15:30.250Z").epochMilliseconds,
  );
});

test("a Send is not past its deadline before or at the deadline", () => {
  const deadline = Temporal.Instant.from("2026-10-22T07:15:30.250Z").epochMilliseconds;

  expect(isPastSendDeadline(deadline, deadline - 60_000)).toBe(false);
  expect(isPastSendDeadline(deadline, deadline)).toBe(false);
});

test("a Send is past its deadline one millisecond after it", () => {
  const deadline = Temporal.Instant.from("2026-10-22T07:15:30.250Z").epochMilliseconds;

  expect(isPastSendDeadline(deadline, deadline + 1)).toBe(true);
});
