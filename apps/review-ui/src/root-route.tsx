import { createRootRoute, Outlet } from "@tanstack/react-router";
import React from "react";

import { AppShell } from "#src/app-shell.tsx";
import { useReviewerSession } from "#src/reviewer-session.ts";
import { TokenScreen } from "#src/token-screen.tsx";

export const rootRoute = createRootRoute({ component: RootLayout });

/** Without a stored token, the token screen replaces the requested route; the URL stays. */
function RootLayout(): React.ReactNode {
  const { token, wasTokenRejected } = useReviewerSession();
  if (token === undefined) {
    return <TokenScreen wasTokenRejected={wasTokenRejected} />;
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
