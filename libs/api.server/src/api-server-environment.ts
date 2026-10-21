import type { DraftsStorage, SendQueue } from "@resend-challenge/drafts";

import type { Role } from "#src/authentication.ts";

/** The Worker bindings and vars the API server reads. */
export type ApiServerEnvironment = {
  /** The public Agent token. */
  AGENT_TOKEN: string;
  /** The Reviewer token, a secret; only local development may leave it unset. */
  REVIEWER_TOKEN?: string;
  /** `"true"` enables the local tokens on local hosts. */
  LOCAL_DEVELOPMENT: string;
  /** The origin of the deployed Worker; `reviewUrl`s point below it. */
  PUBLIC_BASE_URL: string;
  /** The sender of every email, frozen into the outgoing email when the Approval is recorded. */
  RESEND_FROM: string;
  DB: D1Database;
  REVISION_BODIES: R2Bucket;
  /** The Send Queue's producer binding; an Approval hands its Send intent to it. */
  SEND_QUEUE: SendQueue;
  /** The Worker's static assets: the built Review UI, below `app/`. */
  ASSETS: Fetcher;
};

export type ApiServerHonoEnvironment = {
  Bindings: ApiServerEnvironment;
  Variables: {
    requestId: string;
    /** Set by the authentication middleware on every authenticated request. */
    role: Role;
    /** Set by the database session middleware on every `/api/v1` request. */
    draftsStorage: DraftsStorage;
  };
};
