import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

/**
 * Where Drafts live: D1 for the rows, through Drizzle on one D1 session, and R2 for the Revision
 * bodies. The use cases take it as a parameter.
 */
export type DraftsStorage = {
  database: DrizzleD1Database;
  revisionBodies: R2Bucket;
};

type DraftsDatabaseSession = {
  database: DrizzleD1Database;
  /** The session's read bookmark, `null` while no query has run. */
  getBookmark(): string | null;
};

/**
 * Starts a D1 session and wraps it in Drizzle. Writes start with `"first-primary"`; reads start
 * from the client's read bookmark, or unconstrained without one.
 */
export function drizzleForSession(
  d1Database: D1Database,
  sessionStart: Parameters<D1Database["withSession"]>[0],
): DraftsDatabaseSession {
  const session = d1Database.withSession(sessionStart);

  // Drizzle 0.45 types its D1 driver as accepting `D1Database` only, while `withSession()` returns
  // a `D1DatabaseSession`. The driver calls only `prepare()` and `batch()`, which the session has,
  // so this adapter passes the session off as a `D1Database`; the methods a session lacks throw.
  // This is the one place that does so; replace it with the session once Drizzle accepts sessions.
  const sessionAsDatabase: D1Database = {
    prepare: (query) => session.prepare(query),
    batch<T>(statements: D1PreparedStatement[]) {
      return session.batch<T>(statements);
    },
    exec: () => {
      throw new Error("A D1 session has no exec().");
    },
    withSession: () => {
      throw new Error("A D1 session cannot start another session.");
    },
    dump: () => {
      throw new Error("A D1 session has no dump().");
    },
  };

  return { database: drizzle(sessionAsDatabase), getBookmark: () => session.getBookmark() };
}
