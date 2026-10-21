import { expect, test } from "vitest";

import { findRootCause, findRootCauseMessage } from "../src/root-cause.ts";

test("the root cause is the innermost cause, never a wrapping error that carries SQL parameters", () => {
  const rootCause = new Error("D1_ERROR: UNIQUE constraint failed");
  const error = new Error("Failed query: insert … params: secret", {
    cause: new Error("Wrapped", { cause: rootCause }),
  });

  expect(findRootCause(error)).toBe(rootCause);
  expect(findRootCauseMessage(error)).toBe("D1_ERROR: UNIQUE constraint failed");
});

test("an error without a cause is its own root cause", () => {
  const error = new Error("Queue unavailable");

  expect(findRootCause(error)).toBe(error);
  expect(findRootCauseMessage(error)).toBe("Queue unavailable");
});

test("a cause that is not an Error ends the chain, and its message is its string form", () => {
  const error = new Error("Wrapped", { cause: "socket hang up" });

  expect(findRootCause(error)).toBe("socket hang up");
  expect(findRootCauseMessage(error)).toBe("socket hang up");
});
