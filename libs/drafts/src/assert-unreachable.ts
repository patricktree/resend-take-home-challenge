/** Fails to compile when a switch misses a case, and throws if an unexpected value arrives anyway. */
export function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
