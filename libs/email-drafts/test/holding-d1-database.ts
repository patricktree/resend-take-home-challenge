/*
 * A holding D1 test double (spec section 13, "Forcing races"). It wraps the real `DB` binding and
 * holds a chosen statement or batch until the test releases it, so a race such as "A reads,
 * B commits, A writes" happens the same way every time. Production code knows nothing about it:
 * the test passes the wrapped database wherever the code under test takes a `D1Database`.
 */

/** A call that reaches D1: a single statement (`first`, `run`, `all`, `raw`) or a `batch()`. */
type D1Call = { kind: "statement"; query: string } | { kind: "batch"; queries: string[] };

/** A held call, waiting for the test. */
type Hold = {
  /** Resolves with the matching call once it has arrived and is being held. */
  reached: Promise<D1Call>;
  /** Lets the held call run on the real database. */
  release(): void;
};

export type HoldingD1Database = {
  /** The wrapped database; its sessions are wrapped too. */
  database: D1Database;
  /**
   * Holds the next call that matches until the returned hold is released. Each hold keeps one call
   * only; every other call passes straight through.
   */
  holdNext(matches: (call: D1Call) => boolean): Hold;
};

type PendingHold = {
  matches: (call: D1Call) => boolean;
  arrive(call: D1Call): Promise<void>;
};

export function createHoldingD1Database(realDatabase: D1Database): HoldingD1Database {
  const pendingHolds: PendingHold[] = [];

  /** Waits until the call may run: at once, or once the hold that keeps it is released. */
  async function pass(call: D1Call): Promise<void> {
    const holdIndex = pendingHolds.findIndex((hold) => hold.matches(call));
    if (holdIndex === -1) {
      return;
    }

    const [hold] = pendingHolds.splice(holdIndex, 1);
    await hold?.arrive(call);
  }

  function wrapBatch(realBatch: D1Database["batch"]): D1Database["batch"] {
    return async (statements) => {
      const holdableStatements = statements.map((statement) => {
        if (!(statement instanceof HoldingPreparedStatement)) {
          throw new TypeError("A batch on the holding database takes only its own statements.");
        }
        return statement;
      });

      await pass({
        kind: "batch",
        queries: holdableStatements.map((statement) => statement.query),
      });
      return realBatch(holdableStatements.map((statement) => statement.realStatement));
    };
  }

  const database: D1Database = {
    prepare: (query) => new HoldingPreparedStatement(realDatabase.prepare(query), query, pass),
    batch: wrapBatch((statements) => realDatabase.batch(statements)),
    exec: (query) => realDatabase.exec(query),
    withSession: (constraintOrBookmark) => {
      const realSession = realDatabase.withSession(constraintOrBookmark);
      return {
        prepare: (query) => new HoldingPreparedStatement(realSession.prepare(query), query, pass),
        batch: wrapBatch((statements) => realSession.batch(statements)),
        getBookmark: () => realSession.getBookmark(),
      };
    },
    dump: () => realDatabase.dump(),
  };

  return {
    database,
    holdNext(matches) {
      const { promise: reached, resolve: resolveReached } = Promise.withResolvers<D1Call>();
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      pendingHolds.push({
        matches,
        arrive: (call) => {
          resolveReached(call);
          return released;
        },
      });
      return { reached, release };
    },
  };
}

/** A prepared statement whose execution waits for the holds; `bind()` keeps it holdable. */
class HoldingPreparedStatement implements D1PreparedStatement {
  readonly realStatement: D1PreparedStatement;
  readonly query: string;
  readonly #pass: (call: D1Call) => Promise<void>;

  constructor(
    realStatement: D1PreparedStatement,
    query: string,
    pass: (call: D1Call) => Promise<void>,
  ) {
    this.realStatement = realStatement;
    this.query = query;
    this.#pass = pass;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new HoldingPreparedStatement(this.realStatement.bind(...values), this.query, this.#pass);
  }

  first<T = unknown>(columnName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T>(columnName?: string): Promise<T | null> {
    await this.#pass({ kind: "statement", query: this.query });
    return columnName === undefined
      ? this.realStatement.first<T>()
      : this.realStatement.first<T>(columnName);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await this.#pass({ kind: "statement", query: this.query });
    return this.realStatement.run<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await this.#pass({ kind: "statement", query: this.query });
    return this.realStatement.all<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
    await this.#pass({ kind: "statement", query: this.query });
    return options?.columnNames === true
      ? this.realStatement.raw<T>({ columnNames: true })
      : this.realStatement.raw<T>();
  }
}
