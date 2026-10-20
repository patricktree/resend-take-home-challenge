import nodeUrl from "node:url";
import { test } from "vitest";
import { experimental_readRawConfig } from "wrangler";

// The production config, which `pnpm dev` also uses; the expected values come from spec section 12.
const PRODUCTION_CONFIG_PATH = nodeUrl.fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

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
    producers: [{ binding: "SEND_QUEUE", queue: "draft-approval-send" }],
    consumers: [
      {
        queue: "draft-approval-send",
        max_concurrency: 1,
        max_batch_size: 8,
        max_batch_timeout: 1,
        max_retries: 100,
        dead_letter_queue: "draft-approval-send-dlq",
      },
      { queue: "draft-approval-send-dlq" },
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
    AGENT_TOKEN: expect.stringMatching(/^agent_/),
  });
  expect(config.secrets).toStrictEqual({ required: ["REVIEWER_TOKEN", "RESEND_API_KEY"] });
  expect(config.observability).toBeUndefined();
});
