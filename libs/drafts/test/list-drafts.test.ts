import { test } from "vitest";

import { createDraft } from "../src/create-draft.ts";
import { drizzleForSession, type DraftsStorage } from "../src/database.ts";
import { listDrafts, type ListDraftsQuery } from "../src/list-drafts.ts";
import { createHoldingD1Database } from "./holding-d1-database.ts";
import { useBindings, type TestBindings } from "./use-bindings.ts";

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada" },
};

const ORDERINGS = [
  { orderBy: "lastActionAt", order: "desc", indexName: "drafts_last_action_at_id_index" },
  { orderBy: "lastActionAt", order: "asc", indexName: "drafts_last_action_at_id_index" },
  { orderBy: "createdAt", order: "desc", indexName: "drafts_created_at_id_index" },
  { orderBy: "createdAt", order: "asc", indexName: "drafts_created_at_id_index" },
] as const;

for (const { orderBy, order, indexName } of ORDERINGS) {
  test(`a list ordered by ${orderBy} ${order} walks ${indexName} from the cursor, without sorting`, async ({
    expect,
    onTestFinished,
  }) => {
    const bindings = await useBindings({ onTestFinished });
    await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);
    await createDraft(storageOn(bindings.DB, bindings), DRAFT_DATA);
    const unfiltered: ListDraftsQuery = {
      reviewStatuses: [],
      sendingStatuses: [],
      orderBy,
      order,
      limit: 1,
    };
    const firstPage = await listDrafts(storageOn(bindings.DB, bindings), unfiltered);
    if (firstPage.outcome !== "LISTED" || firstPage.nextCursor === undefined) {
      throw new Error("The first page has no next cursor.");
    }

    const pagePlan = await explainQueryPlan(
      bindings.DB,
      await captureListQuery(bindings, { ...unfiltered, cursor: firstPage.nextCursor }),
    );
    const filteredPlan = await explainQueryPlan(
      bindings.DB,
      await captureListQuery(bindings, {
        ...unfiltered,
        reviewStatuses: ["APPROVED", "REJECTED"],
        sendingStatuses: ["SENT"],
      }),
    );

    expect(pagePlan).toContainEqual(
      expect.stringMatching(new RegExp(`^SEARCH drafts USING INDEX ${indexName} \\(\\(`)),
    );
    expect(filteredPlan).toContainEqual(expect.stringContaining(`drafts USING INDEX ${indexName}`));
    expect([...pagePlan, ...filteredPlan]).not.toContainEqual(
      expect.stringContaining("TEMP B-TREE"),
    );
  });
}

/** Runs a list on the holding database and returns the SQL of its one statement. */
async function captureListQuery(bindings: TestBindings, query: ListDraftsQuery): Promise<string> {
  const holdingDatabase = createHoldingD1Database(bindings.DB);
  const hold = holdingDatabase.holdNext((call) => call.kind === "statement");
  const listing = listDrafts(storageOn(holdingDatabase.database, bindings), query);
  const call = await hold.reached;
  hold.release();
  await listing;

  if (call.kind !== "statement") {
    throw new Error("The list ran a batch instead of one statement.");
  }
  return call.query;
}

/** The details of the query's plan; the plan does not depend on the values, so all are `NULL`. */
async function explainQueryPlan(database: D1Database, query: string): Promise<string[]> {
  const parameterCount = query.match(/\?/g)?.length ?? 0;
  const { results } = await database
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...Array.from({ length: parameterCount }, () => null))
    .all<{ detail: string }>();
  return results.map((row) => row.detail);
}

function storageOn(database: D1Database, bindings: TestBindings): DraftsStorage {
  return {
    database: drizzleForSession(database, "first-primary").database,
    revisionBodies: bindings.REVISION_BODIES,
  };
}
