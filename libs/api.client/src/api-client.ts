import { hc } from "hono/client";

import type {
  ApiContractApp,
  DraftDataRequest,
  DraftListResponse,
  DraftResponse,
  DraftSummaryResponse,
  ErrorCode,
  ErrorExtras,
  ErrorResponse,
  ListDraftsQuery,
  RejectionRequest,
  ReviseRequest,
  RevisionResponse,
} from "@draft-approval/api.routes";

export type DraftApprovalClientOptions = {
  /** The origin the API runs on, for example `https://resend-challenge.patricktree.me`. */
  baseUrl: string;
  /** The Agent token or the Reviewer token, sent as `Authorization: Bearer …`. */
  token: string;
  /**
   * Sends a request; `globalThis.fetch` by default. The MCP server passes one that calls the Hono
   * app in-process, tests one that calls the test Worker.
   */
  fetch?: (request: Request) => Promise<Response>;
};

type ErrorBody = ErrorResponse["error"];

/**
 * Only types come from the contract package, so the client does not bundle the contract's runtime;
 * the API documents this header name as `READ_BOOKMARK_HEADER`.
 */
const READ_BOOKMARK_HEADER = "X-Read-Bookmark";

/**
 * The routes declare the optional `X-Read-Bookmark` request header, so Hono RPC asks for a `header`
 * argument; `#send` adds the bookmark to every request instead.
 */
const NO_HEADERS = {};

/** An error response of the API, with the envelope's code, message, request id and extras. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly requestId: string;
  readonly extras: ErrorExtras;

  constructor(status: number, { code, message, requestId, ...extras }: ErrorBody) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.extras = extras;
  }
}

/**
 * The typed client of the HTTP API, on Hono RPC. It keeps the latest read bookmark it receives and
 * sends it on every request, so it reads its own writes. Every error response throws
 * {@link ApiError}.
 */
export class DraftApprovalClient {
  readonly #honoClient;
  readonly #token: string;
  readonly #fetch: (request: Request) => Promise<Response>;
  #readBookmark: string | undefined;

  constructor({ baseUrl, token, fetch = globalThis.fetch }: DraftApprovalClientOptions) {
    this.#token = token;
    this.#fetch = fetch;
    this.#honoClient = hc<ApiContractApp>(baseUrl.replace(/\/$/, ""), {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => this.#send(new Request(input, init)),
    });
  }

  /** Creates a Draft whose first Revision, `UNSUBMITTED`, holds the Draft data. */
  async createDraft(draftData: DraftDataRequest): Promise<DraftSummaryResponse> {
    const response = await this.#honoClient.api.v1.drafts.$post({
      header: NO_HEADERS,
      json: draftData,
    });
    if (response.status === 201) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /** Reads a Draft with its latest Revision, including the body. */
  async getDraft(draftId: string): Promise<DraftResponse> {
    const response = await this.#honoClient.api.v1.drafts[":draftId"].$get({
      header: NO_HEADERS,
      param: { draftId },
    });
    if (response.status === 200) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /**
   * Revises a Draft: creates its next Revision, `UNSUBMITTED`, built on `baseRevisionId`. Throws
   * {@link ApiError} with `REVISION_SUPERSEDED` when another revise came first, and with
   * `DRAFT_APPROVED` when the Draft is approved.
   */
  async reviseDraft(draftId: string, reviseRequest: ReviseRequest): Promise<DraftSummaryResponse> {
    const response = await this.#honoClient.api.v1.drafts[":draftId"].revisions.$post({
      header: NO_HEADERS,
      param: { draftId },
      json: reviseRequest,
    });
    if (response.status === 201) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /** Reads any of a Draft's Revisions, including Superseded ones, with its body. */
  async getRevision(draftId: string, revisionId: string): Promise<RevisionResponse> {
    const response = await this.#honoClient.api.v1.drafts[":draftId"].revisions[":revisionId"].$get(
      {
        header: NO_HEADERS,
        param: { draftId, revisionId },
      },
    );
    if (response.status === 200) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /**
   * Submits one Revision, the Draft's latest and `UNSUBMITTED`, for review; the Draft becomes
   * `PENDING`. Throws {@link ApiError} with `REVISION_ALREADY_SUBMITTED` when the Revision is
   * already Pending (for example after a retried request), with `REVISION_SUPERSEDED` when it is no
   * longer the latest, with `REVISION_ALREADY_DECIDED` (and `existingVerdict`) when it has a
   * verdict, and with `DRAFT_APPROVED` when the Draft is approved.
   */
  async submitRevision(draftId: string, revisionId: string): Promise<DraftSummaryResponse> {
    const response = await this.#honoClient.api.v1.drafts[":draftId"].revisions[
      ":revisionId"
    ].submission.$post({
      header: NO_HEADERS,
      param: { draftId, revisionId },
    });
    if (response.status === 200) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /**
   * Reads one page of Draft summaries, filtered and ordered by `query`. Pass the page's
   * `nextCursor` as `cursor`, with the same filters and ordering, to read the next page; a cursor
   * used with other filters or another ordering throws {@link ApiError} with `INVALID_REQUEST`.
   */
  async listDrafts({ limit, ...query }: ListDraftsQuery = {}): Promise<DraftListResponse> {
    const response = await this.#honoClient.api.v1.drafts.$get({
      header: NO_HEADERS,
      // Hono RPC repeats array values as query parameters; numbers travel as strings.
      query: { ...query, ...(limit === undefined ? {} : { limit: String(limit) }) },
    });
    if (response.status === 200) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /**
   * Approves one Revision, the Draft's latest and `PENDING`; Reviewer token only. The Draft becomes
   * `APPROVED` with sending status `QUEUED`. Throws {@link ApiError} with `REVIEWER_ONLY` for any
   * other token, with `REVISION_SUPERSEDED` when the Revision is no longer the latest, with
   * `REVISION_ALREADY_DECIDED` (and `existingVerdict`) when it already has a verdict, also after a
   * retried request, and with `REVISION_NOT_SUBMITTED` when it is `UNSUBMITTED`.
   */
  async approveRevision(draftId: string, revisionId: string): Promise<DraftSummaryResponse> {
    const response = await this.#honoClient.api.v1.drafts[":draftId"].revisions[
      ":revisionId"
    ].approval.$post({
      header: NO_HEADERS,
      param: { draftId, revisionId },
    });
    if (response.status === 200) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /**
   * Rejects one Revision, the Draft's latest and `PENDING`, optionally with a reason; Reviewer
   * token only. Throws {@link ApiError} with the same codes as {@link approveRevision}.
   */
  async rejectRevision(
    draftId: string,
    revisionId: string,
    rejectionRequest: RejectionRequest = {},
  ): Promise<DraftSummaryResponse> {
    const response = await this.#honoClient.api.v1.drafts[":draftId"].revisions[
      ":revisionId"
    ].rejection.$post({
      header: NO_HEADERS,
      param: { draftId, revisionId },
      json: rejectionRequest,
    });
    if (response.status === 200) {
      return response.json();
    }
    throw await toApiError(response);
  }

  /** Adds the token and the latest read bookmark to every request and keeps the returned bookmark. */
  async #send(request: Request): Promise<Response> {
    request.headers.set("Authorization", `Bearer ${this.#token}`);
    if (this.#readBookmark !== undefined) {
      request.headers.set(READ_BOOKMARK_HEADER, this.#readBookmark);
    }

    const response = await this.#fetch(request);

    const readBookmark = response.headers.get(READ_BOOKMARK_HEADER);
    if (readBookmark !== null) {
      this.#readBookmark = readBookmark;
    }
    return response;
  }
}

/**
 * Turns an error response into {@link ApiError}. A response without the error envelope, such as one
 * from a proxy in front of the API, throws a plain error naming its status.
 */
async function toApiError(response: { status: number; text(): Promise<string> }): Promise<Error> {
  const text = await response.text();
  const body = parseJson(text);
  if (!isErrorEnvelope(body)) {
    return new Error(`The API answered with status ${response.status} and no error envelope.`);
  }
  return new ApiError(response.status, body.error);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isErrorEnvelope(value: unknown): value is ErrorResponse {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return false;
  }
  const { error } = value;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string" &&
    "requestId" in error &&
    typeof error.requestId === "string"
  );
}
