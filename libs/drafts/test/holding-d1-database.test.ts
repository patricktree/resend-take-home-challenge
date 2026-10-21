import { test } from "vitest";

import { createHoldingD1Database } from "#test/holding-d1-database.ts";
import { useBindings } from "#test/use-bindings.ts";

test("a held statement runs only once the test releases it", async ({ expect, onTestFinished }) => {
  const { DB } = await useBindings({ onTestFinished });
  await DB.exec("CREATE TABLE events (name TEXT NOT NULL)");
  const holdingDatabase = createHoldingD1Database(DB);

  const hold = holdingDatabase.holdNext(
    (call) => call.kind === "statement" && call.query.startsWith("INSERT"),
  );
  const heldInsert = holdingDatabase.database
    .prepare("INSERT INTO events (name) VALUES (?)")
    .bind("held")
    .run();
  const heldCall = await hold.reached;
  await DB.prepare("INSERT INTO events (name) VALUES (?)").bind("first").run();
  hold.release();
  await heldInsert;

  expect(heldCall).toStrictEqual({
    kind: "statement",
    query: "INSERT INTO events (name) VALUES (?)",
  });
  const { results } = await DB.prepare("SELECT name FROM events ORDER BY rowid").all();
  expect(results).toStrictEqual([{ name: "first" }, { name: "held" }]);
});

test("a held batch on a session runs only once the test releases it", async ({
  expect,
  onTestFinished,
}) => {
  const { DB } = await useBindings({ onTestFinished });
  await DB.exec("CREATE TABLE events (name TEXT NOT NULL)");
  const holdingDatabase = createHoldingD1Database(DB);
  const session = holdingDatabase.database.withSession("first-primary");

  const hold = holdingDatabase.holdNext((call) => call.kind === "batch");
  const heldBatch = session.batch([
    session.prepare("INSERT INTO events (name) VALUES ('held 1')"),
    session.prepare("INSERT INTO events (name) VALUES ('held 2')"),
  ]);
  const heldCall = await hold.reached;
  await DB.prepare("INSERT INTO events (name) VALUES ('first')").run();
  hold.release();
  await heldBatch;

  expect(heldCall).toStrictEqual({
    kind: "batch",
    queries: [
      "INSERT INTO events (name) VALUES ('held 1')",
      "INSERT INTO events (name) VALUES ('held 2')",
    ],
  });
  const { results } = await DB.prepare("SELECT name FROM events ORDER BY rowid").all();
  expect(results).toStrictEqual([{ name: "first" }, { name: "held 1" }, { name: "held 2" }]);
  expect(session.getBookmark()).toMatch(/^\S+$/);
});

test("calls that match no hold, and calls after a hold was used, pass straight through", async ({
  expect,
  onTestFinished,
}) => {
  const { DB } = await useBindings({ onTestFinished });
  await DB.exec("CREATE TABLE events (name TEXT NOT NULL)");
  const holdingDatabase = createHoldingD1Database(DB);
  const insert = holdingDatabase.database.prepare("INSERT INTO events (name) VALUES (?)");

  const hold = holdingDatabase.holdNext((call) => call.kind === "batch");
  await insert.bind("not a batch").run();
  const heldBatch = holdingDatabase.database.batch([insert.bind("held")]);
  await hold.reached;
  hold.release();
  await heldBatch;
  await holdingDatabase.database.batch([insert.bind("after the hold")]);

  const { results } = await DB.prepare("SELECT name FROM events ORDER BY rowid").all();
  expect(results).toStrictEqual([
    { name: "not a batch" },
    { name: "held" },
    { name: "after the hold" },
  ]);
});
