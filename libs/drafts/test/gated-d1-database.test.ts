import { test } from "vitest";

import { createGatedD1Database } from "#test/gated-d1-database.ts";
import { useBindings } from "#test/use-bindings.ts";

test("a held statement runs only once the test releases it", async ({ expect, onTestFinished }) => {
  const { DB } = await useBindings({ onTestFinished });
  await DB.exec("CREATE TABLE events (name TEXT NOT NULL)");
  const gatedDatabase = createGatedD1Database(DB);

  const gate = gatedDatabase.holdNext(
    (call) => call.kind === "statement" && call.query.startsWith("INSERT"),
  );
  const heldInsert = gatedDatabase.database
    .prepare("INSERT INTO events (name) VALUES (?)")
    .bind("held")
    .run();
  const heldCall = await gate.reached;
  await DB.prepare("INSERT INTO events (name) VALUES (?)").bind("first").run();
  gate.release();
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
  const gatedDatabase = createGatedD1Database(DB);
  const session = gatedDatabase.database.withSession("first-primary");

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  const heldBatch = session.batch([
    session.prepare("INSERT INTO events (name) VALUES ('held 1')"),
    session.prepare("INSERT INTO events (name) VALUES ('held 2')"),
  ]);
  const heldCall = await gate.reached;
  await DB.prepare("INSERT INTO events (name) VALUES ('first')").run();
  gate.release();
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

test("calls that match no gate, and calls after a gate was used, pass straight through", async ({
  expect,
  onTestFinished,
}) => {
  const { DB } = await useBindings({ onTestFinished });
  await DB.exec("CREATE TABLE events (name TEXT NOT NULL)");
  const gatedDatabase = createGatedD1Database(DB);
  const insert = gatedDatabase.database.prepare("INSERT INTO events (name) VALUES (?)");

  const gate = gatedDatabase.holdNext((call) => call.kind === "batch");
  await insert.bind("not a batch").run();
  const heldBatch = gatedDatabase.database.batch([insert.bind("held")]);
  await gate.reached;
  gate.release();
  await heldBatch;
  await gatedDatabase.database.batch([insert.bind("after the gate")]);

  const { results } = await DB.prepare("SELECT name FROM events ORDER BY rowid").all();
  expect(results).toStrictEqual([
    { name: "not a batch" },
    { name: "held" },
    { name: "after the gate" },
  ]);
});
