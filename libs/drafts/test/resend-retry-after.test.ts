import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";

import { parseRetryAfterSeconds } from "../src/resend/post-email.ts";

const NOW = Temporal.Instant.from("2026-10-21T08:00:00.000Z").epochMilliseconds;

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
