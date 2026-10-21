import assert from "node:assert/strict";
import http from "node:http";
import type { onTestFinished as OnTestFinished } from "vitest";

export type RecordedRequest = {
  method: string;
  pathname: string;
  /** Every query parameter in order, so repeated parameters stay visible. */
  query: Array<[string, string]>;
  authorization: string | undefined;
  /** The parsed JSON body; `undefined` without one. */
  body: unknown;
};

export type StubResponse = { status: number; body: unknown };

export type ApiStub = {
  /** The stub's origin on 127.0.0.1, for `--api-url` or `RESEND_CHALLENGE_API_URL`. */
  url: string;
  /** Every request the stub received, in order. */
  requests: RecordedRequest[];
};

/**
 * A `node:http` stand-in for the API on an OS-assigned port, closed when the test finishes. It
 * records every request and answers with whatever `respond` returns; by default a 404.
 */
export async function useApiStub(
  onTestFinished: typeof OnTestFinished,
  respond: (request: RecordedRequest) => StubResponse = () => ({
    status: 404,
    body: { error: { code: "NOT_FOUND", message: "Not found.", requestId: "req_stub" } },
  }),
): Promise<ApiStub> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const text = await readText(request);
    const recordedRequest: RecordedRequest = {
      method: request.method ?? "GET",
      pathname: requestUrl.pathname,
      query: [...requestUrl.searchParams.entries()],
      authorization: request.headers.authorization,
      body: text === "" ? undefined : JSON.parse(text),
    };
    requests.push(recordedRequest);

    const { status, body } = respond(recordedRequest);
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  const url = await listenOnAssignedPort(server);
  onTestFinished(() => closeServer(server));

  return { url, requests };
}

/** An origin on 127.0.0.1 where nothing listens: a port the OS assigned and that is closed again. */
export async function getUnreachableUrl(): Promise<string> {
  const server = http.createServer();
  const url = await listenOnAssignedPort(server);
  await closeServer(server);
  return url;
}

/** Listens on 127.0.0.1 on a port the OS assigns, and returns the origin. */
async function listenOnAssignedPort(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(typeof address === "object" && address !== null, "The server listens on no TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function readText(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
