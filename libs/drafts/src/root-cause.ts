/**
 * The message of an error's root cause. Paths that handle an error log only this: wrapping errors
 * such as Drizzle's carry SQL parameters (spec section 9, "Error reporting").
 */
export function findRootCauseMessage(error: unknown): string {
  let cause = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
