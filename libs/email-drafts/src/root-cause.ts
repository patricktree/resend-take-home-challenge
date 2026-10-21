/*
 * Error reporting logs only an error's root cause, the error that actually went wrong (spec section
 * 9, "Error reporting"): wrapping errors add no diagnosis, and some, such as Drizzle's, carry SQL
 * parameters, which must never be logged. Every path that logs a caught error goes through here.
 */

/** The innermost cause of an error: the first value in its `cause` chain that has no cause. */
export function findRootCause(error: unknown): unknown {
  let cause = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
  }
  return cause;
}

/** The message of an error's root cause, for log lines that add their own context. */
export function findRootCauseMessage(error: unknown): string {
  const rootCause = findRootCause(error);
  return rootCause instanceof Error ? rootCause.message : String(rootCause);
}
