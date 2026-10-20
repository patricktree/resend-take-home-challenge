import { test } from "vitest";

import { useWorker } from "#test/use-worker.ts";

test("the D1 migrations are applied before the test starts", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const env = await worker.getEnv();

  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
  ).all();

  expect(tables.results).toStrictEqual([{ name: "d1_migrations" }]);
});

test("every Worker starts with empty storage", async ({ expect, onTestFinished }) => {
  const [first, second] = await Promise.all([
    useWorker({ onTestFinished }),
    useWorker({ onTestFinished }),
  ]);
  const firstEnv = await first.getEnv();
  const secondEnv = await second.getEnv();

  await firstEnv.REVISION_BODIES.put("revisions/rev_example/body", '{"plainText":"Hello"}');
  await firstEnv.DB.exec("CREATE TABLE example (id TEXT PRIMARY KEY)");

  expect((await secondEnv.REVISION_BODIES.list()).objects).toStrictEqual([]);
  const tables = await secondEnv.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'example'",
  ).all();
  expect(tables.results).toStrictEqual([]);
});
