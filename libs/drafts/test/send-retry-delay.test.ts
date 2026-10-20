import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";

import { computeRetryDelaySeconds, parseRetryAfterSeconds } from "#src/send-retry-delay.ts";

const NOW = Temporal.Instant.from("2026-10-21T08:00:00.000Z").epochMilliseconds;

/** A deadline far enough away that it never clamps. */
const DISTANT_DEADLINE = NOW + 23 * 60 * 60 * 1000;

test.for([
  { attempts: 1, delaySeconds: 1 },
  { attempts: 2, delaySeconds: 2 },
  { attempts: 3, delaySeconds: 4 },
  { attempts: 4, delaySeconds: 8 },
  { attempts: 11, delaySeconds: 1024 },
  { attempts: 12, delaySeconds: 2048 },
])(
  "the backoff starts at 1 s and doubles per attempt: attempt $attempts waits $delaySeconds s",
  ({ attempts, delaySeconds }) => {
    expect(
      computeRetryDelaySeconds({ attempts, jitter: 0, deadline: DISTANT_DEADLINE, now: NOW }),
    ).toBe(delaySeconds);
  },
);

test.for([13, 14, 35, 100])("the backoff is capped at 1 h (attempt %i)", (attempts) => {
  expect(
    computeRetryDelaySeconds({ attempts, jitter: 0, deadline: DISTANT_DEADLINE, now: NOW }),
  ).toBe(3600);
});

test("the jitter adds up to 1 s", () => {
  const delays = [0, 0.001, 0.5, 0.999].map((jitter) =>
    computeRetryDelaySeconds({ attempts: 3, jitter, deadline: DISTANT_DEADLINE, now: NOW }),
  );

  expect(delays).toStrictEqual([4, 5, 5, 5]);
});

test("the jitter also applies on top of the 1 h cap", () => {
  expect(
    computeRetryDelaySeconds({ attempts: 20, jitter: 0.5, deadline: DISTANT_DEADLINE, now: NOW }),
  ).toBe(3601);
});

test("a Retry-After longer than the backoff wins", () => {
  expect(
    computeRetryDelaySeconds({
      attempts: 1,
      jitter: 0.5,
      retryAfterSeconds: 30,
      deadline: DISTANT_DEADLINE,
      now: NOW,
    }),
  ).toBe(30);
});

test("a Retry-After shorter than the backoff does not shorten it", () => {
  expect(
    computeRetryDelaySeconds({
      attempts: 6,
      jitter: 0,
      retryAfterSeconds: 2,
      deadline: DISTANT_DEADLINE,
      now: NOW,
    }),
  ).toBe(32);
});

test("the delay is clamped so that the next delivery is no later than the deadline", () => {
  expect(
    computeRetryDelaySeconds({ attempts: 12, jitter: 0.9, deadline: NOW + 90_500, now: NOW }),
  ).toBe(90);
  expect(
    computeRetryDelaySeconds({
      attempts: 1,
      jitter: 0,
      retryAfterSeconds: 600,
      deadline: NOW + 45_000,
      now: NOW,
    }),
  ).toBe(45);
});

test("at or past the deadline the delay is 0", () => {
  expect(computeRetryDelaySeconds({ attempts: 5, jitter: 0.5, deadline: NOW, now: NOW })).toBe(0);
  expect(
    computeRetryDelaySeconds({ attempts: 5, jitter: 0.5, deadline: NOW - 1000, now: NOW }),
  ).toBe(0);
});

test("the delay never exceeds the Queue's 12 h maximum, even for a longer Retry-After", () => {
  expect(
    computeRetryDelaySeconds({
      attempts: 1,
      jitter: 0,
      retryAfterSeconds: 86_400,
      deadline: DISTANT_DEADLINE,
      now: NOW,
    }),
  ).toBe(43_200);
});

test.for([
  { value: "0", seconds: 0 },
  { value: "1", seconds: 1 },
  { value: " 120 ", seconds: 120 },
])("a Retry-After of '$value' delta-seconds is $seconds s", ({ value, seconds }) => {
  expect(parseRetryAfterSeconds(value, NOW)).toBe(seconds);
});

test("a Retry-After HTTP date is the seconds until then, rounded up", () => {
  expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 08:00:30 GMT", NOW - 500)).toBe(31);
});

test("a Retry-After HTTP date in the past is 0 s", () => {
  expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:59:00 GMT", NOW)).toBe(0);
});

test.for([
  "",
  "soon",
  "-5",
  "1.5",
  "2026-10-21T08:00:30Z",
  "Sat, 31 Feb 2026 08:00:00 GMT",
  "Wed, 21 Oct 2026 08:00:30 UTC",
])("an unreadable Retry-After ('%s') is ignored", (value) => {
  expect(parseRetryAfterSeconds(value, NOW)).toBeUndefined();
});
