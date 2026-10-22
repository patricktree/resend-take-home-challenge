import { css } from "@linaria/core";
import { Link } from "@tanstack/react-router";
import React from "react";

import { DSButton } from "./design-system/button.tsx";
import { signOut } from "./query-client.ts";

type AppShellProps = {
  children: React.ReactNode;
};

/** The header of every screen, above the content in one centred column. */
export function AppShell({ children }: AppShellProps): React.ReactNode {
  return (
    <div className={columnStyles}>
      <header className={headerStyles}>
        <nav aria-label="Lists">
          <ul className={navListStyles}>
            <li>
              <Link to="/" activeOptions={{ exact: true }}>
                Pending
              </Link>
            </li>
            <li>
              <Link to="/decided">Decided</Link>
            </li>
          </ul>
        </nav>
        <DSButton variant="outlined" type="button" onClick={signOut}>
          Sign out
        </DSButton>
      </header>
      <main>{children}</main>
    </div>
  );
}

const columnStyles = css`
  display: grid;
  gap: calc(3 * var(--spacing-base));
  max-width: var(--app-max-width);
  margin-inline: auto;
  padding-block: var(--app-padding-block);
  padding-inline: var(--app-padding-inline);
`;

const headerStyles = css`
  display: flex;
  gap: calc(2 * var(--spacing-base));
  align-items: center;
  justify-content: space-between;
`;

const navListStyles = css`
  display: flex;
  gap: calc(2 * var(--spacing-base));
  padding: 0;
  list-style: none;

  & a[aria-current="page"] {
    font-weight: var(--font-weight-inter-figma-medium);
    text-decoration-thickness: 2px;
  }
`;
