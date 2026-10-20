import { createMiddleware } from "hono/factory";

import { READ_BOOKMARK_HEADER } from "@draft-approval/api.routes";
import { drizzleForSession } from "@draft-approval/drafts";

import type { ApiServerHonoEnvironment } from "#src/api-server-environment.ts";

/**
 * Runs the request on a D1 session and sets `database`. Writes start the session on the primary;
 * reads start it from the client's `X-Read-Bookmark`, or unconstrained without one, so a client
 * that sends its latest bookmark reads its own writes. The response carries the session's
 * bookmark.
 */
export const runOnDatabaseSession = createMiddleware<ApiServerHonoEnvironment>(
  async (context, next) => {
    const isRead = context.req.method === "GET" || context.req.method === "HEAD";
    const presentedBookmark = context.req.header(READ_BOOKMARK_HEADER) || undefined;
    const sessionStart = isRead ? presentedBookmark : "first-primary";
    const session = drizzleForSession(context.env.DB, sessionStart);
    context.set("database", session.database);

    await next();

    const bookmark = session.getBookmark();
    if (bookmark !== null) {
      context.header(READ_BOOKMARK_HEADER, bookmark);
    }
  },
);
