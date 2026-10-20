/*
 * Fixed tokens for local development, tests and e2e runs. The Worker accepts them only when
 * `LOCAL_DEVELOPMENT` is "true" and the request host is local, so they are worthless against a
 * deployed Worker and safe to commit.
 */

export const LOCAL_AGENT_TOKEN = "agent_local-development-only";

export const LOCAL_REVIEWER_TOKEN = "reviewer_local-development-only";
