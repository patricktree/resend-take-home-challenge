import fs from "node:fs/promises";
import nodeUrl from "node:url";
import { test } from "vitest";
import { experimental_readRawConfig } from "wrangler";

import { SEND_DLQ_NAME, SEND_QUEUE_NAME } from "@resend-challenge/email-drafts";

// The production config, which `pnpm dev` also uses; the expected values come from spec section 12.
const PRODUCTION_CONFIG_PATH = nodeUrl.fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

/** Every other Wrangler config, and the Terraform that creates the production Queues. */
const TEST_CONFIG_PATH = nodeUrl.fileURLToPath(new URL("wrangler.test.jsonc", import.meta.url));
const E2E_CONFIG_PATH = nodeUrl.fileURLToPath(
  new URL("../../../qa/e2e/wrangler.jsonc", import.meta.url),
);
const TERRAFORM_CLOUDFLARE_URL = new URL("../../../terraform/cloudflare.tf", import.meta.url);

function readProductionConfig() {
  return experimental_readRawConfig({ config: PRODUCTION_CONFIG_PATH }).rawConfig;
}

test("the Worker is served only on its custom domain", ({ expect }) => {
  const config = readProductionConfig();

  expect(config.routes).toStrictEqual([
    { pattern: "resend-challenge.patricktree.me", custom_domain: true },
  ]);
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.compatibility_flags).toStrictEqual(["nodejs_compat"]);
});

test("the Send reconciler's cron fires every minute", ({ expect }) => {
  const config = readProductionConfig();

  expect(config.triggers).toStrictEqual({ crons: ["* * * * *"] });
});

test("the Send Queue has a producer, a paced consumer with a DLQ, and the DLQ has a consumer", ({
  expect,
}) => {
  const config = readProductionConfig();

  expect(config.queues).toStrictEqual({
    producers: [{ binding: "SEND_QUEUE", queue: "resend-challenge-send" }],
    consumers: [
      {
        queue: "resend-challenge-send",
        max_concurrency: 1,
        max_batch_size: 8,
        max_batch_timeout: 1,
        max_retries: 100,
        dead_letter_queue: "resend-challenge-send-dlq",
      },
      { queue: "resend-challenge-send-dlq" },
    ],
  });
});

test("every request reaches the Worker before static assets", ({ expect }) => {
  const config = readProductionConfig();

  expect(config.assets).toStrictEqual({
    binding: "ASSETS",
    run_worker_first: true,
    html_handling: "none",
    not_found_handling: "none",
  });
});

test("the vars configure production and the secrets are required", ({ expect }) => {
  const config = readProductionConfig();

  expect(config.vars).toStrictEqual({
    PUBLIC_BASE_URL: "https://resend-challenge.patricktree.me",
    RESEND_FROM: "drafts@resend-challenge.patricktree.me",
    RESEND_BASE_URL: "https://api.resend.com",
    LOCAL_DEVELOPMENT: "false",
  });
  expect(config.secrets).toStrictEqual({
    required: ["AGENT_TOKEN", "REVIEWER_TOKEN", "RESEND_API_KEY"],
  });
  expect(config.observability).toBeUndefined();
});

// `handleQueueBatch()` dispatches on the batch's queue name, so a config that names a Queue
// differently from libs/email-drafts would leave its batches without a consumer.
test.for([
  { name: "production", configPath: PRODUCTION_CONFIG_PATH },
  { name: "integration test", configPath: TEST_CONFIG_PATH },
  { name: "e2e", configPath: E2E_CONFIG_PATH },
])(
  "the $name Wrangler config names exactly the Send Queue and its DLQ that libs/email-drafts consumes",
  ({ configPath }, { expect }) => {
    const { rawConfig } = experimental_readRawConfig({ config: configPath });

    const queueNames = new Set(collectQueueNames(rawConfig));

    expect([...queueNames].toSorted()).toStrictEqual([SEND_QUEUE_NAME, SEND_DLQ_NAME].toSorted());
  },
);

test("Terraform creates the Send Queue and its DLQ under the names libs/email-drafts consumes", async ({
  expect,
}) => {
  const terraform = await fs.readFile(TERRAFORM_CLOUDFLARE_URL, "utf8");

  const queueNames = [...terraform.matchAll(/queue_name\s*=\s*"([^"]+)"/g)].flatMap(
    ([, queueName]) => (queueName === undefined ? [] : [queueName]),
  );

  expect(queueNames.toSorted()).toStrictEqual([SEND_QUEUE_NAME, SEND_DLQ_NAME].toSorted());
});

/** Every value of a `queue` or `dead_letter_queue` key anywhere in a config, its environments too. */
function collectQueueNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectQueueNames(item));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    (key === "queue" || key === "dead_letter_queue") && typeof child === "string"
      ? [child]
      : collectQueueNames(child),
  );
}
