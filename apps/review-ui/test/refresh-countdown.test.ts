import { expect, test } from "vitest";

import { refreshCountdownSeconds } from "../src/refresh-countdown.ts";

const INTERVAL_MILLISECONDS = 5000;

test("right after a read, the full interval remains", () => {
  expect(
    refreshCountdownSeconds({
      dataUpdatedAt: 10_000,
      errorUpdatedAt: 0,
      now: 10_000,
      intervalMilliseconds: INTERVAL_MILLISECONDS,
    }),
  ).toBe(5);
});

test("partial seconds round up", () => {
  expect(
    refreshCountdownSeconds({
      dataUpdatedAt: 10_000,
      errorUpdatedAt: 0,
      now: 12_500,
      intervalMilliseconds: INTERVAL_MILLISECONDS,
    }),
  ).toBe(3);
});

test("a read that is due stays at 0 rather than going negative", () => {
  expect(
    refreshCountdownSeconds({
      dataUpdatedAt: 10_000,
      errorUpdatedAt: 0,
      now: 30_000,
      intervalMilliseconds: INTERVAL_MILLISECONDS,
    }),
  ).toBe(0);
});

test("a failed read restarts the countdown, like a successful one", () => {
  expect(
    refreshCountdownSeconds({
      dataUpdatedAt: 10_000,
      errorUpdatedAt: 15_000,
      now: 16_000,
      intervalMilliseconds: INTERVAL_MILLISECONDS,
    }),
  ).toBe(4);
});

test("a clock behind the last read shows the full interval", () => {
  expect(
    refreshCountdownSeconds({
      dataUpdatedAt: 10_000,
      errorUpdatedAt: 0,
      now: 9000,
      intervalMilliseconds: INTERVAL_MILLISECONDS,
    }),
  ).toBe(5);
});
