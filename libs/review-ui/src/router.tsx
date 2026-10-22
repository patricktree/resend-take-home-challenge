import { createRouter, type ErrorComponentProps } from "@tanstack/react-router";
import React from "react";

import { decidedListRoute, pendingListRoute } from "./draft-lists.tsx";
import { draftRoute } from "./draft-page.tsx";
import { ErrorMessage } from "./error-message.tsx";
import { rootRoute } from "./root-route.tsx";

export const router = createRouter({
  basepath: "/app",
  routeTree: rootRoute.addChildren([pendingListRoute, decidedListRoute, draftRoute]),
  // Shown while a route's query suspends, and for the errors it throws.
  defaultPendingComponent: Loading,
  defaultErrorComponent: RouteError,
});

function Loading(): React.ReactNode {
  return <p>Loading…</p>;
}

function RouteError({ error }: ErrorComponentProps): React.ReactNode {
  return <ErrorMessage error={error} />;
}
