import { expect, test } from "vitest";

import { LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN } from "@resend-challenge/api.routes";

import { resolveRole } from "../src/authentication.ts";

const AGENT_TOKEN = "agent_configured-agent-token";
const REVIEWER_TOKEN = "reviewer_configured-reviewer-token";
const CONFIGURATION = {
  agentToken: AGENT_TOKEN,
  reviewerToken: REVIEWER_TOKEN,
  acceptsLocalTokens: false,
};

test("the configured Agent token resolves to AGENT", () => {
  expect(resolveRole(AGENT_TOKEN, CONFIGURATION)).toBe("AGENT");
});

test("the configured Reviewer token resolves to REVIEWER", () => {
  expect(resolveRole(REVIEWER_TOKEN, CONFIGURATION)).toBe("REVIEWER");
});

test.each([
  "agent_unknown-token",
  `${AGENT_TOKEN}x`,
  AGENT_TOKEN.slice(0, -1),
  AGENT_TOKEN.toUpperCase(),
  ` ${AGENT_TOKEN}`,
  "",
])("the unknown token %j resolves to no role", (presentedToken) => {
  expect(resolveRole(presentedToken, CONFIGURATION)).toBeUndefined();
});

test("the role comes from which token matched, not from the token's prefix", () => {
  const configuration = { ...CONFIGURATION, agentToken: "reviewer_looks-like-a-reviewer" };

  expect(resolveRole("reviewer_looks-like-a-reviewer", configuration)).toBe("AGENT");
});

test("the local tokens resolve to their roles only when local tokens are accepted", () => {
  const acceptingConfiguration = { ...CONFIGURATION, acceptsLocalTokens: true };

  expect(resolveRole(LOCAL_AGENT_TOKEN, acceptingConfiguration)).toBe("AGENT");
  expect(resolveRole(LOCAL_REVIEWER_TOKEN, acceptingConfiguration)).toBe("REVIEWER");
  expect(resolveRole(LOCAL_AGENT_TOKEN, CONFIGURATION)).toBeUndefined();
  expect(resolveRole(LOCAL_REVIEWER_TOKEN, CONFIGURATION)).toBeUndefined();
});

test("without a configured Reviewer token only Agent tokens resolve", () => {
  const configuration = {
    agentToken: AGENT_TOKEN,
    reviewerToken: undefined,
    acceptsLocalTokens: false,
  };

  expect(resolveRole(AGENT_TOKEN, configuration)).toBe("AGENT");
  expect(resolveRole(REVIEWER_TOKEN, configuration)).toBeUndefined();
});

test("without a configured Agent token only the local Agent token resolves to AGENT", () => {
  const configuration = {
    agentToken: undefined,
    reviewerToken: undefined,
    acceptsLocalTokens: true,
  };

  expect(resolveRole(LOCAL_AGENT_TOKEN, configuration)).toBe("AGENT");
  expect(resolveRole(AGENT_TOKEN, configuration)).toBeUndefined();
});

test("the configured tokens still resolve while local tokens are accepted", () => {
  const configuration = { ...CONFIGURATION, acceptsLocalTokens: true };

  expect(resolveRole(AGENT_TOKEN, configuration)).toBe("AGENT");
  expect(resolveRole(REVIEWER_TOKEN, configuration)).toBe("REVIEWER");
});
