import { CommanderError } from "@commander-js/extra-typings";

import { ApiError, ERROR_CODE, type ErrorCode } from "@resend-challenge/api.client";

/** The API's codes and the CLI's own. */
export type CliErrorCode = ErrorCode | (typeof CLI_ERROR_CODE)[keyof typeof CLI_ERROR_CODE];

/**
 * What the CLI prints on stderr for every failure: code and message, plus the request id and extras
 * (such as `issues` or `existingVerdict`) where there are any, like the API's error envelope.
 */
export type ErrorEnvelope = {
  error: { code: CliErrorCode; message: string } & Record<string, unknown>;
};

/**
 * The codes of failures that happen before or instead of an API response; API errors keep the API's
 * own code, and local input errors use the API's `INVALID_REQUEST`.
 */
export const CLI_ERROR_CODE = {
  /** `RESEND_CHALLENGE_TOKEN` is unset or empty, so the CLI has no token to send. */
  TOKEN_NOT_SET: "TOKEN_NOT_SET",
  /** The API could not be reached: DNS, connection or TLS failure. */
  NETWORK_ERROR: "NETWORK_ERROR",
  /** Anything else, such as a response without the API's error envelope. */
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",
} as const;

/** A failure the CLI detects itself, with the code and message it prints. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly extras: Record<string, unknown>;

  constructor(code: CliErrorCode, message: string, extras: Record<string, unknown> = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.extras = extras;
  }
}

/** Turns any failure into the envelope printed on stderr; messages never contain the token. */
export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof ApiError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        requestId: error.requestId,
        ...error.extras,
      },
    };
  }
  if (error instanceof CliError) {
    return { error: { code: error.code, message: error.message, ...error.extras } };
  }
  if (error instanceof CommanderError) {
    // Commander's own usage errors: unknown commands and options, missing arguments.
    return {
      error: {
        code: ERROR_CODE.INVALID_REQUEST,
        message: `${error.message.replace(/^error: /, "").replace(/\.$/, "")}. Run with --help for usage.`,
      },
    };
  }
  return {
    error: {
      code: CLI_ERROR_CODE.UNEXPECTED_ERROR,
      message: error instanceof Error ? error.message : "The command failed unexpectedly.",
    },
  };
}
