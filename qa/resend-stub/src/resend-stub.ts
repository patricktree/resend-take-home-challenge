/*
 * A `node:http` stand-in for Resend's `POST /emails` (spec section 13, "Resend stub"), one instance
 * per test on an OS-assigned port. By default it models Resend's idempotency with a ledger keyed by
 * `Idempotency-Key`; a test can script the next requests' answers instead. The live contract test
 * (`pnpm test:resend-live`) checks the model against the real API.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import util from "node:util";

/** One request the stub received. */
export type ResendStubRequest = {
  method: string;
  pathname: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  /** The parsed JSON body; the raw text when it is not JSON, `undefined` without one. */
  body: unknown;
};

/** An email the stub accepted: one per idempotency key, as Resend sends one per key. */
export type AcceptedEmail = {
  id: string;
  idempotencyKey: string | undefined;
  /** The request body that sent it. */
  email: unknown;
};

export type ScriptedResponse = {
  status: number;
  /** Sent as JSON; without one the response has no body. */
  body?: unknown;
  headers?: Record<string, string>;
};

/** A request the stub holds open: it runs through the ledger, but answers only once released. */
export type HeldRequest = {
  /** Resolves once the held request has arrived and its key is in flight. */
  received: Promise<void>;
  release(): void;
};

export type ResendStub = {
  /** The stub's origin on 127.0.0.1, for `RESEND_BASE_URL`. */
  url: string;
  /** Every request, in arrival order. */
  requests: readonly ResendStubRequest[];
  /** The ledger's accepted emails, in the order they were accepted. */
  emails: readonly AcceptedEmail[];
  /** Answers the next request with this response instead of the ledger. */
  respondNext(response: ScriptedResponse): void;
  /** Never answers the next request, as an unresponsive Resend would; it sends nothing. */
  hangNext(): void;
  /** Holds the next request open until the test releases it. */
  holdNext(): HeldRequest;
  close(): Promise<void>;
};

type Override =
  | { kind: "RESPOND"; response: ScriptedResponse }
  | { kind: "HANG" }
  | { kind: "HOLD"; markReceived(): void; released: Promise<void> };

type LedgerEntry = { email: unknown } & ({ state: "IN_FLIGHT" } | { state: "SENT"; id: string });

/** A response in Resend's error shape. */
export function resendError(status: number, name: string, message: string): ScriptedResponse {
  return { status, body: { statusCode: status, name, message } };
}

/** Starts a stub on 127.0.0.1 on a port the OS assigns; the caller closes it. */
export async function startResendStub(): Promise<ResendStub> {
  const requests: ResendStubRequest[] = [];
  const emails: AcceptedEmail[] = [];
  const overrides: Override[] = [];
  const ledger = new Map<string, LedgerEntry>();

  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const text = await readText(request);
    const idempotencyKey = request.headers["idempotency-key"];
    assert(!Array.isArray(idempotencyKey), "A request carries more than one Idempotency-Key.");
    const body = parseBody(text);
    requests.push({
      method: request.method ?? "GET",
      pathname: requestUrl.pathname,
      authorization: request.headers.authorization,
      idempotencyKey,
      body,
    });

    if (request.method !== "POST" || requestUrl.pathname !== "/emails") {
      respond(response, resendError(404, "not_found", "The requested endpoint does not exist."));
      return;
    }

    const override = overrides.shift();
    if (override?.kind === "RESPOND") {
      respond(response, override.response);
      return;
    }
    if (override?.kind === "HANG") {
      return;
    }
    const hold = override;

    const entry = idempotencyKey === undefined ? undefined : ledger.get(idempotencyKey);
    if (entry !== undefined) {
      hold?.markReceived();
      await hold?.released;
      respond(response, answerReplay(entry, body));
      return;
    }

    if (idempotencyKey !== undefined) {
      ledger.set(idempotencyKey, { state: "IN_FLIGHT", email: body });
    }
    hold?.markReceived();
    await hold?.released;

    const id = crypto.randomUUID();
    if (idempotencyKey !== undefined) {
      ledger.set(idempotencyKey, { state: "SENT", id, email: body });
    }
    emails.push({ id, idempotencyKey, email: body });
    respond(response, { status: 200, body: { id } });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(typeof address === "object" && address !== null, "The stub listens on no TCP port.");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emails,
    respondNext: (response) => {
      overrides.push({ kind: "RESPOND", response });
    },
    hangNext: () => {
      overrides.push({ kind: "HANG" });
    },
    holdNext: () => {
      const received = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      overrides.push({ kind: "HOLD", markReceived: received.resolve, released: released.promise });
      return { received: received.promise, release: released.resolve };
    },
    close: async () => {
      // Hung and held requests would otherwise keep `close()` waiting forever.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/** Resend's answer to a key it has seen before. */
function answerReplay(entry: LedgerEntry, body: unknown): ScriptedResponse {
  if (entry.state === "IN_FLIGHT") {
    return resendError(
      409,
      "concurrent_idempotent_requests",
      "Same idempotency key used while original request is still in progress.",
    );
  }
  if (!util.isDeepStrictEqual(entry.email, body)) {
    return resendError(
      409,
      "invalid_idempotent_request",
      "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified.",
    );
  }
  return { status: 200, body: { id: entry.id } };
}

function respond(response: http.ServerResponse, { status, body, headers }: ScriptedResponse) {
  if (body === undefined) {
    response.writeHead(status, headers).end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function parseBody(text: string): unknown {
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readText(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
