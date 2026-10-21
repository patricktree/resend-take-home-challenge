import { test } from "vitest";

import { LOCAL_AGENT_TOKEN, LOCAL_REVIEWER_TOKEN } from "@draft-approval/api.routes";

import { useWorker } from "#test/use-worker.ts";

const REVISION_PATH =
  "/api/v1/drafts/drf_00000000-0000-7000-8000-000000000000/revisions/rev_00000000-0000-7000-8000-000000000000";

const AGENT_HEADERS = {
  Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

const VALID_DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Hello",
  body: { plainText: "Hello Ada" },
};

const BODY_LIMIT_BYTES = 100 * 1024;
const REQUEST_LIMIT_BYTES = 128 * 1024;

test.for([
  { name: "1 recipient", to: ["ada@example.com"] },
  { name: "50 recipients", to: recipients(50) },
  { name: "1-character subject", subject: "H" },
  { name: "998-character subject", subject: "x".repeat(998) },
  // "📧" is one character, but two UTF-16 code units.
  { name: "998-character subject of emoji", subject: "📧".repeat(998) },
  { name: "1-character body", plainText: "H" },
  { name: "body of exactly 100 KB in ASCII", plainText: "x".repeat(BODY_LIMIT_BYTES) },
  // "é" takes 2 bytes in UTF-8.
  { name: "body of exactly 100 KB in UTF-8", plainText: "é".repeat(BODY_LIMIT_BYTES / 2) },
])("a Draft with a $name is created", async (override, { expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify(draftDataWith(override)),
  });

  expect(response.status).toBe(201);
});

test.for([
  { name: "no recipient", override: { to: [] }, path: ["to"] },
  { name: "51 recipients", override: { to: recipients(51) }, path: ["to"] },
  { name: "an invalid address", override: { to: ["ada.example.com"] }, path: ["to", 0] },
  {
    name: "a duplicate recipient",
    override: { to: ["ada@example.com", "grace@example.com", "ada@example.com"] },
    path: ["to"],
  },
  {
    name: "a duplicate recipient in other case",
    override: { to: ["ada@example.com", "Ada@Example.com"] },
    path: ["to"],
  },
  { name: "an empty subject", override: { subject: "" }, path: ["subject"] },
  { name: "a 999-character subject", override: { subject: "x".repeat(999) }, path: ["subject"] },
  {
    name: "a 999-character subject of emoji",
    override: { subject: "📧".repeat(999) },
    path: ["subject"],
  },
  { name: "a subject with a line feed", override: { subject: "Hello\nBcc: x" }, path: ["subject"] },
  {
    name: "a subject with a carriage return",
    override: { subject: "Hello\rx" },
    path: ["subject"],
  },
  { name: "an empty body", override: { plainText: "" }, path: ["body", "plainText"] },
  {
    name: "a body of 100 KB plus 1 byte in ASCII",
    override: { plainText: "x".repeat(BODY_LIMIT_BYTES + 1) },
    path: ["body", "plainText"],
  },
  {
    name: "a body of 100 KB plus 1 byte in UTF-8, though fewer characters",
    override: { plainText: `${"é".repeat(BODY_LIMIT_BYTES / 2)}x` },
    path: ["body", "plainText"],
  },
])(
  "a Draft with $name answers with 400 INVALID_REQUEST",
  async ({ override, path }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch("/api/v1/drafts", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify(draftDataWith(override)),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "The request is invalid; see `issues`.",
        requestId: response.headers.get("X-Request-Id"),
        issues: [{ path, message: expect.any(String) }],
      },
    });
  },
);

test.for([
  { name: "without recipients", draftData: { subject: "Hello", body: { plainText: "Hello" } } },
  { name: "with a recipient that is no string", draftData: { ...VALID_DRAFT_DATA, to: [42] } },
  { name: "with a plain-text body", draftData: { ...VALID_DRAFT_DATA, body: "Hello" } },
  {
    name: "with an unknown field",
    draftData: { ...VALID_DRAFT_DATA, cc: ["grace@example.com"] },
  },
  {
    name: "with an unknown body field",
    draftData: { ...VALID_DRAFT_DATA, body: { plainText: "Hello", html: "<p>Hello</p>" } },
  },
])(
  "a Draft $name answers with 400 INVALID_REQUEST",
  async ({ draftData }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch("/api/v1/drafts", {
      method: "POST",
      headers: AGENT_HEADERS,
      body: JSON.stringify(draftData),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", issues: [expect.anything()] },
    });
  },
);

test("a request body that is not JSON answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: '{"to": [',
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "INVALID_REQUEST",
      message: "The request is invalid; see `issues`.",
      requestId: response.headers.get("X-Request-Id"),
      issues: [{ path: [], message: "Malformed JSON in request body" }],
    },
  });
});

test("a request without a JSON content type answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: { ...AGENT_HEADERS, "Content-Type": "text/plain" },
    body: JSON.stringify(VALID_DRAFT_DATA),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      code: "INVALID_REQUEST",
      issues: [
        {
          path: [],
          message: "The request body must be JSON, sent with `Content-Type: application/json`.",
        },
      ],
    },
  });
});

test("a valid request body of exactly 128 KB is accepted", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: padJson(VALID_DRAFT_DATA, REQUEST_LIMIT_BYTES),
  });

  expect(response.status).toBe(201);
});

test("a request body of 128 KB plus 1 byte answers with 413 PAYLOAD_TOO_LARGE", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: padJson(VALID_DRAFT_DATA, REQUEST_LIMIT_BYTES + 1),
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body exceeds 131072 bytes.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
});

test.for([
  { name: "submit", path: `${REVISION_PATH}/submission`, token: LOCAL_AGENT_TOKEN },
  { name: "approve", path: `${REVISION_PATH}/approval`, token: LOCAL_REVIEWER_TOKEN },
])(
  "a request body over 128 KB to $name, which takes no body, answers with 413 PAYLOAD_TOO_LARGE",
  async ({ path, token }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });

    const response = await worker.fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: padJson({}, REQUEST_LIMIT_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  },
);

test("a request body over 128 KB without Content-Length answers with 413 PAYLOAD_TOO_LARGE", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const bytes = new TextEncoder().encode(padJson(VALID_DRAFT_DATA, REQUEST_LIMIT_BYTES + 1));

  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: "half",
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
});

type DraftDataOverride = { to?: string[]; subject?: string; plainText?: string };

function draftDataWith({ to, subject, plainText }: DraftDataOverride) {
  return {
    to: to ?? VALID_DRAFT_DATA.to,
    subject: subject ?? VALID_DRAFT_DATA.subject,
    body: { plainText: plainText ?? VALID_DRAFT_DATA.body.plainText },
  };
}

function recipients(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `recipient-${index}@example.com`);
}

/** Serializes a value as JSON, padded with trailing whitespace to exactly `byteLength` bytes. */
function padJson(value: unknown, byteLength: number): string {
  const json = JSON.stringify(value);
  return json + " ".repeat(byteLength - new TextEncoder().encode(json).byteLength);
}
