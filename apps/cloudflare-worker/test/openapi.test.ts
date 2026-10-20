import { test } from "vitest";

import { useWorker } from "#test/use-worker.ts";

test("the published OpenAPI document matches the committed snapshot", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/openapi.json");

  expect(response.status).toBe(200);
  const document: unknown = await response.json();
  // Update the snapshot with `pnpm --filter '@draft-approval/cloudflare-worker' test -u`.
  await expect(`${JSON.stringify(document, undefined, 2)}\n`).toMatchFileSnapshot(
    "./__snapshots__/openapi.json",
  );
});

test("the OpenAPI document is OpenAPI 3.1 and declares both bearer schemes", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/openapi.json");

  expect(await response.json()).toMatchObject({
    openapi: "3.1.0",
    components: {
      securitySchemes: {
        agentAuth: { type: "http", scheme: "bearer" },
        reviewerAuth: { type: "http", scheme: "bearer" },
      },
    },
  });
});
