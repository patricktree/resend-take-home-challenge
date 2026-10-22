/**
 * Whole seconds until a polled list's next automatic read, rounded up.
 *
 * TanStack Query restarts the refetch interval after every read, failed ones included, so the
 * countdown runs from the later of the last success (`dataUpdatedAt`) and the last failure
 * (`errorUpdatedAt`); counting from successes alone would stay at 0 while reads keep failing.
 */
export function refreshCountdownSeconds({
  dataUpdatedAt,
  errorUpdatedAt,
  now,
  intervalMilliseconds,
}: {
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  now: number;
  intervalMilliseconds: number;
}): number {
  const lastReadAt = Math.max(dataUpdatedAt, errorUpdatedAt);
  const remainingMilliseconds = Math.max(
    0,
    lastReadAt + intervalMilliseconds - Math.max(now, lastReadAt),
  );
  return Math.ceil(remainingMilliseconds / 1000);
}
