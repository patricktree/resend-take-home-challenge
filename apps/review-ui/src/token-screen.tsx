import { css } from "@linaria/core";
import React from "react";

import { DSButton } from "#src/design-system/button.tsx";
import { textFieldStyles } from "#src/design-system/text-field.ts";
import { storeReviewerToken } from "#src/reviewer-session.ts";

type TokenScreenProps = {
  /** Whether the API answered 401 to the token that was stored last. */
  wasTokenRejected: boolean;
};

/**
 * The prefix of the Agent token (tooling/secrets-generate/src/secrets-generate.ts generates it),
 * which the Review UI refuses before any request.
 */
const AGENT_TOKEN_PREFIX = "agent_";

/**
 * Rendered in place of the requested route while no token is stored, so the URL stays and a
 * `reviewUrl` lands on its Draft once the token is entered.
 */
export function TokenScreen({ wasTokenRejected }: TokenScreenProps): React.ReactNode {
  const tokenInputId = React.useId();
  const [isAgentTokenRefused, setIsAgentTokenRefused] = React.useState(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const token = new FormData(event.currentTarget).get("token");
    if (typeof token !== "string") {
      throw new TypeError("The token form has no `token` field.");
    }

    const trimmedToken = token.trim();
    if (trimmedToken.startsWith(AGENT_TOKEN_PREFIX)) {
      setIsAgentTokenRefused(true);
      return;
    }
    storeReviewerToken(trimmedToken);
  }

  let notice: string | undefined;
  if (isAgentTokenRefused) {
    notice = "This is an Agent token. Enter the Reviewer token.";
  } else if (wasTokenRejected) {
    notice = "The token was not accepted.";
  }

  return (
    <main className={screenStyles}>
      <h1>Email Draft Approval</h1>
      <form className={formStyles} onSubmit={handleSubmit}>
        <label htmlFor={tokenInputId}>Reviewer token</label>
        <input
          id={tokenInputId}
          className={textFieldStyles}
          name="token"
          type="password"
          autoComplete="current-password"
          required
        />
        {notice !== undefined && <p role="alert">{notice}</p>}
        <DSButton variant="contained" type="submit" className={continueButtonStyles}>
          Continue
        </DSButton>
      </form>
    </main>
  );
}

const screenStyles = css`
  display: grid;
  gap: calc(3 * var(--spacing-base));
  max-width: 480px;
  margin-inline: auto;
  padding-block: calc(6 * var(--spacing-base));
  padding-inline: var(--app-padding-inline);
`;

const formStyles = css`
  display: grid;
  gap: var(--spacing-base);
`;

const continueButtonStyles = css`
  justify-self: start;
`;
