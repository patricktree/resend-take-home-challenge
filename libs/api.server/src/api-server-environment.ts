import type { Role } from "#src/authentication.ts";

/** The Worker bindings and vars the API server reads. */
export type ApiServerEnvironment = {
  /** The public Agent token. */
  AGENT_TOKEN: string;
  /** The Reviewer token, a secret; only local development may leave it unset. */
  REVIEWER_TOKEN?: string;
  /** `"true"` enables the local tokens on local hosts. */
  LOCAL_DEVELOPMENT: string;
};

export type ApiServerHonoEnvironment = {
  Bindings: ApiServerEnvironment;
  Variables: {
    requestId: string;
    /** Set by the authentication middleware on every authenticated request. */
    role: Role;
  };
};
