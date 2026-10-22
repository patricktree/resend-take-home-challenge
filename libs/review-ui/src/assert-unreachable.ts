/** Marks the end of an exhaustive check; reaching it at runtime means the API sent a new value. */
export function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
