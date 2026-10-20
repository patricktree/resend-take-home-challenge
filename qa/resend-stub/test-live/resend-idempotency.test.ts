/*
 * The live Resend contract test (spec section 13), opt-in through `pnpm test:resend-live` and never
 * part of validation. It checks the one assumption no local test can: that the Resend stub's
 * idempotency model matches the real API. Every test sends real emails, to `delivered@resend.dev`
 * only, under a fresh idempotency key.
 */

import * as jsonc from "jsonc-parser";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { test } from "vitest";

const RESEND_BASE_URL = "https://api.resend.com";

const WRANGLER_CONFIG_URL = new URL(
  "../../../apps/cloudflare-worker/wrangler.jsonc",
  import.meta.url,
);

const resendApiKey = process.env["RESEND_API_KEY"] ?? "";
if (resendApiKey === "") {
  throw new Error(
    "pnpm test:resend-live needs RESEND_API_KEY, a Resend API key with sending access; it sends real emails to delivered@resend.dev. RESEND_FROM is optional and defaults to RESEND_FROM of apps/cloudflare-worker/wrangler.jsonc.",
  );
}
const resendFrom = process.env["RESEND_FROM"] || (await readProductionVar("RESEND_FROM"));

test("the same key with the same body returns the same email id", async ({ expect }) => {
  const idempotencyKey = createIdempotencyKey();
  const email = createEmail();

  const first = await postEmail(idempotencyKey, email);
  const replay = await postEmail(idempotencyKey, email);

  expect(first.status).toBe(200);
  expect(replay.status).toBe(200);
  expect(replay.body).toStrictEqual({ id: readEmailId(first.body) });
});

test("the same key with a different body answers 409 invalid_idempotent_request", async ({
  expect,
}) => {
  const idempotencyKey = createIdempotencyKey();
  const email = createEmail();

  const first = await postEmail(idempotencyKey, email);
  const modified = await postEmail(idempotencyKey, {
    ...email,
    subject: `${email.subject}, modified`,
  });

  expect(first.status).toBe(200);
  expect(modified.status).toBe(409);
  expect(modified.body).toMatchObject({ name: "invalid_idempotent_request" });
});

test("two concurrent requests with the same key give one success and one 409 concurrent_idempotent_requests, or the same id twice", async ({
  expect,
}) => {
  const idempotencyKey = createIdempotencyKey();
  const email = createEmail();

  const responses = await Promise.all([
    postEmail(idempotencyKey, email),
    postEmail(idempotencyKey, email),
  ]);

  const successes = responses.filter(({ status }) => status === 200);
  const conflicts = responses.filter(({ status }) => status === 409);
  if (successes.length === 2) {
    expect(successes[1]?.body).toStrictEqual({ id: readEmailId(successes[0]?.body) });
  } else {
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.body).toMatchObject({ name: "concurrent_idempotent_requests" });
  }
});

function createIdempotencyKey(): string {
  return `draft-approval-live-test/${crypto.randomUUID()}`;
}

/** An email shaped like the ones the Send Queue consumer sends. */
function createEmail() {
  const runId = crypto.randomUUID();
  return {
    from: resendFrom,
    to: ["delivered@resend.dev"],
    subject: `draft-approval live contract test ${runId}`,
    text: "Sent by pnpm test:resend-live.",
    tags: [{ name: "draft_id", value: `live-test-${runId}` }],
  };
}

async function postEmail(
  idempotencyKey: string,
  email: ReturnType<typeof createEmail>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${RESEND_BASE_URL}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "User-Agent": "draft-approval-live-test",
    },
    body: JSON.stringify(email),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

function readEmailId(body: unknown): string {
  assert(
    typeof body === "object" && body !== null && "id" in body && typeof body.id === "string",
    `Resend answered without an email id: ${JSON.stringify(body)}`,
  );
  return body.id;
}

/** A var of the production Worker's `wrangler.jsonc`. */
async function readProductionVar(name: string): Promise<string> {
  const configTree = jsonc.parseTree(await fs.readFile(WRANGLER_CONFIG_URL, "utf8"));
  const value: unknown = configTree && jsonc.findNodeAtLocation(configTree, ["vars", name])?.value;
  assert(typeof value === "string", `wrangler.jsonc configures no \`vars.${name}\``);
  return value;
}
