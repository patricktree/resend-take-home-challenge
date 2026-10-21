import assert from "node:assert/strict";
import { test, type TestContext } from "vitest";

import { resendError, startResendStub, type ResendStub } from "../src/resend-stub.ts";

const EMAIL = {
  from: "drafts@example.com",
  to: ["ada@example.com"],
  subject: "Hello",
  text: "Hello Ada.",
  tags: [{ name: "draft_id", value: "drf_1" }],
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("a new idempotency key sends the email: 200 with a new id, and the ledger holds the email", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useStub({ onTestFinished });

  const response = await postEmail(stub, "key-1", EMAIL);

  expect(response.status).toBe(200);
  const id = await readEmailId(response);
  expect(id).toMatch(UUID_PATTERN);
  expect(stub.emails).toStrictEqual([{ id, idempotencyKey: "key-1", email: EMAIL }]);
  expect(stub.requests).toStrictEqual([
    {
      method: "POST",
      pathname: "/emails",
      authorization: "Bearer re_test",
      idempotencyKey: "key-1",
      body: EMAIL,
    },
  ]);
});

test("the same key with the same body returns the original id and sends nothing new", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useStub({ onTestFinished });
  const firstId = await readEmailId(await postEmail(stub, "key-1", EMAIL));

  const replay = await postEmail(stub, "key-1", { ...EMAIL });

  expect(replay.status).toBe(200);
  expect(await replay.json()).toStrictEqual({ id: firstId });
  expect(stub.emails).toHaveLength(1);
});

test("the same key with a different body answers 409 invalid_idempotent_request", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useStub({ onTestFinished });
  await postEmail(stub, "key-1", EMAIL);

  const response = await postEmail(stub, "key-1", { ...EMAIL, subject: "Hello again" });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    statusCode: 409,
    name: "invalid_idempotent_request",
  });
  expect(stub.emails).toHaveLength(1);
});

test("the same key while the first request is in flight answers 409 concurrent_idempotent_requests", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useStub({ onTestFinished });
  const held = stub.holdNext();
  const first = postEmail(stub, "key-1", EMAIL);
  await held.received;

  const concurrent = await postEmail(stub, "key-1", EMAIL);

  expect(concurrent.status).toBe(409);
  expect(await concurrent.json()).toMatchObject({
    statusCode: 409,
    name: "concurrent_idempotent_requests",
  });
  expect(stub.emails).toStrictEqual([]);

  held.release();
  const firstResponse = await first;
  expect(firstResponse.status).toBe(200);
  const id = await readEmailId(firstResponse);
  expect(stub.emails).toStrictEqual([{ id, idempotencyKey: "key-1", email: EMAIL }]);
});

test("different keys send different emails", async ({ expect, onTestFinished }) => {
  const stub = await useStub({ onTestFinished });

  await postEmail(stub, "key-1", EMAIL);
  await postEmail(stub, "key-2", EMAIL);

  expect(stub.emails.map(({ idempotencyKey }) => idempotencyKey)).toStrictEqual(["key-1", "key-2"]);
  expect(new Set(stub.emails.map(({ id }) => id)).size).toBe(2);
});

test("a scripted response answers the next request instead of the ledger, then the ledger answers again", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useStub({ onTestFinished });
  stub.respondNext({
    ...resendError(429, "rate_limit_exceeded", "Too many requests."),
    headers: { "Retry-After": "7" },
  });

  const limited = await postEmail(stub, "key-1", EMAIL);
  const accepted = await postEmail(stub, "key-1", EMAIL);

  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("7");
  expect(await limited.json()).toStrictEqual({
    statusCode: 429,
    name: "rate_limit_exceeded",
    message: "Too many requests.",
  });
  expect(accepted.status).toBe(200);
  expect(stub.emails).toHaveLength(1);
  expect(stub.requests).toHaveLength(2);
});

test("scripted responses apply in order", async ({ expect, onTestFinished }) => {
  const stub = await useStub({ onTestFinished });
  stub.respondNext(resendError(500, "application_error", "Internal error."));
  stub.respondNext({ status: 200, body: {} });

  const statuses = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await postEmail(stub, "key-1", EMAIL);
    statuses.push([response.status, await response.json()]);
  }

  expect(statuses).toStrictEqual([
    [500, { statusCode: 500, name: "application_error", message: "Internal error." }],
    [200, {}],
    [200, { id: stub.emails[0]?.id }],
  ]);
});

test("a held request with a scripted response gets that response once released, and sends nothing", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useStub({ onTestFinished });
  const held = stub.holdNext(resendError(422, "validation_error", "Invalid `to` field."));
  const refused = postEmail(stub, "key-1", EMAIL);
  await held.received;
  const STILL_HELD = "still held";

  const earlyAnswer = await Promise.race([
    refused,
    new Promise((resolve) => setTimeout(() => resolve(STILL_HELD), 50)),
  ]);
  expect(earlyAnswer).toBe(STILL_HELD);
  held.release();
  const response = await refused;

  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ name: "validation_error" });
  expect(stub.emails).toStrictEqual([]);
  // The key never reached the ledger, so the next request with it sends the email.
  expect((await postEmail(stub, "key-1", EMAIL)).status).toBe(200);
  expect(stub.emails).toHaveLength(1);
});

test("a hung request never gets an answer and sends nothing", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useStub({ onTestFinished });
  stub.hangNext();

  const hung = postEmail(stub, "key-1", EMAIL, AbortSignal.timeout(300));

  await expect(hung).rejects.toThrow(expect.objectContaining({ name: "TimeoutError" }));
  expect(stub.requests).toHaveLength(1);
  expect(stub.emails).toStrictEqual([]);
});

test("other routes answer 404 with Resend's error shape", async ({ expect, onTestFinished }) => {
  const stub = await useStub({ onTestFinished });

  const response = await fetch(`${stub.url}/emails/batch`, { method: "POST", body: "[]" });

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ statusCode: 404, name: "not_found" });
});

async function useStub({ onTestFinished }: Pick<TestContext, "onTestFinished">) {
  const stub = await startResendStub();
  onTestFinished(() => stub.close());
  return stub;
}

async function postEmail(
  stub: ResendStub,
  idempotencyKey: string,
  email: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${stub.url}/emails`, {
    method: "POST",
    headers: {
      Authorization: "Bearer re_test",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(email),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function readEmailId(response: Response): Promise<string> {
  const body: unknown = await response.json();
  assert(
    typeof body === "object" && body !== null && "id" in body && typeof body.id === "string",
    "The response carries no email id.",
  );
  return body.id;
}
