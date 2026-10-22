import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import {
  unsubmittedDraftSummarySchema,
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  type UnsubmittedDraftSummaryResponse,
} from "@resend-challenge/api.routes";

import { reviewUrlOf, useWorker, type TestWorker } from "./use-worker.ts";

const AGENT_HEADERS = {
  Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada,\n\nthe report is attached.\n" },
};

const REVISED_DRAFT_DATA = {
  to: ["ada@example.com", "grace@example.com"],
  subject: "Quarterly report, revised",
  body: { plainText: "Hello Ada and Grace,\n\nthe revised report is attached.\n" },
};

const REVISION_ID_PATTERN =
  /^rev_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNKNOWN_DRAFT_ID = "drf_00000000-0000-7000-8000-000000000000";
const UNKNOWN_REVISION_ID = "rev_00000000-0000-7000-8000-000000000000";

test("revising answers with 201 and a Draft summary of Revision 2 built on the base", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const before = Temporal.Now.instant().epochMilliseconds;
  const response = await reviseDraft(worker, created.id, {
    ...REVISED_DRAFT_DATA,
    baseRevisionId: created.latestRevision.id,
  });
  const after = Temporal.Now.instant().epochMilliseconds;

  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  const revised = unsubmittedDraftSummarySchema.parse(body);
  expect(body).toStrictEqual({
    ...created,
    lastActionAt: revised.latestRevision.createdAt,
    latestRevision: {
      id: expect.stringMatching(REVISION_ID_PATTERN),
      revisionNumber: 2,
      createdAt: expect.any(String),
      to: ["ada@example.com", "grace@example.com"],
      subject: "Quarterly report, revised",
      reviewStatus: "UNSUBMITTED",
    },
  });
  expect(revised.latestRevision.id).not.toBe(created.latestRevision.id);
  const revisedAt = Temporal.Instant.from(revised.latestRevision.createdAt).epochMilliseconds;
  expect(revisedAt).toBeGreaterThanOrEqual(before);
  expect(revisedAt).toBeLessThanOrEqual(after);
});

test("after a revise, getting the Draft answers with the new Revision and its body", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const revised = await expectRevised(
    worker,
    created.id,
    REVISED_DRAFT_DATA,
    created.latestRevision.id,
  );

  const response = await worker.fetch(`/api/v1/drafts/${created.id}`, { headers: AGENT_HEADERS });

  expect(await response.json()).toStrictEqual({
    ...revised,
    reviewUrl: reviewUrlOf(revised.id),
    latestRevision: { ...revised.latestRevision, body: REVISED_DRAFT_DATA.body },
  });
});

test("revising supersedes an Unsubmitted base, which stays readable with its own data", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  await expectRevised(worker, created.id, REVISED_DRAFT_DATA, created.latestRevision.id);

  const response = await getRevision(worker, created.id, created.latestRevision.id);

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    ...created.latestRevision,
    reviewStatus: "SUPERSEDED",
    body: DRAFT_DATA.body,
  });
});

test("getting a Revision answers with any of the Draft's Revisions, with its body", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const second = await expectRevised(
    worker,
    created.id,
    REVISED_DRAFT_DATA,
    created.latestRevision.id,
  );
  const third = await expectRevised(
    worker,
    created.id,
    { ...REVISED_DRAFT_DATA, subject: "Third" },
    second.latestRevision.id,
  );

  const responses = await Promise.all(
    [created, second, third].map((draft) =>
      getRevision(worker, created.id, draft.latestRevision.id),
    ),
  );

  expect(await Promise.all(responses.map((response) => response.json()))).toStrictEqual([
    { ...created.latestRevision, reviewStatus: "SUPERSEDED", body: DRAFT_DATA.body },
    { ...second.latestRevision, reviewStatus: "SUPERSEDED", body: REVISED_DRAFT_DATA.body },
    { ...third.latestRevision, body: REVISED_DRAFT_DATA.body },
  ]);
  expect(third.latestRevision.revisionNumber).toBe(3);
});

test("revising a Rejected base keeps it Rejected", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  await expectSubmittedAndDecided(worker, created.id, created.latestRevision.id, "rejection");

  const revised = await expectRevised(
    worker,
    created.id,
    REVISED_DRAFT_DATA,
    created.latestRevision.id,
  );
  const base = await getRevision(worker, created.id, created.latestRevision.id);

  expect(revised.latestRevision).toMatchObject({ revisionNumber: 2, reviewStatus: "UNSUBMITTED" });
  expect(await base.json()).toMatchObject({
    reviewStatus: "REJECTED",
    rejectionReason: "Wrong recipient",
  });
});

test("revising on a base that is no longer the latest answers with 409 REVISION_SUPERSEDED and changes nothing", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  await expectRevised(worker, created.id, REVISED_DRAFT_DATA, created.latestRevision.id);
  const rowsBefore = await readRows(worker);

  const response = await reviseDraft(worker, created.id, {
    ...DRAFT_DATA,
    baseRevisionId: created.latestRevision.id,
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "REVISION_SUPERSEDED",
      message: expect.any(String),
      requestId: response.headers.get("X-Request-Id"),
    },
  });
  expect(await readRows(worker)).toStrictEqual(rowsBefore);
});

test.for([
  { name: "on its latest Revision", isBaseLatest: true },
  { name: "on a superseded base", isBaseLatest: false },
])(
  "revising an approved Draft $name answers with 409 DRAFT_APPROVED and changes nothing",
  async ({ isBaseLatest }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const revised = await expectRevised(
      worker,
      created.id,
      REVISED_DRAFT_DATA,
      created.latestRevision.id,
    );
    await expectSubmittedAndDecided(worker, created.id, revised.latestRevision.id, "approval");
    const rowsBefore = await readRows(worker);

    const response = await reviseDraft(worker, created.id, {
      ...DRAFT_DATA,
      baseRevisionId: isBaseLatest ? revised.latestRevision.id : created.latestRevision.id,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "DRAFT_APPROVED",
        message: expect.any(String),
        requestId: response.headers.get("X-Request-Id"),
      },
    });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test.for([
  { name: "an unknown Revision", isOtherDraftsRevision: false },
  { name: "another Draft's Revision", isOtherDraftsRevision: true },
])(
  "revising an approved Draft on $name answers with 404 REVISION_NOT_FOUND and changes nothing",
  async ({ isOtherDraftsRevision }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const other = await createDraft(worker);
    await expectSubmittedAndDecided(worker, created.id, created.latestRevision.id, "approval");
    const rowsBefore = await readRows(worker);

    // REVISION_NOT_FOUND takes precedence over DRAFT_APPROVED, as for Submissions and verdicts.
    const response = await reviseDraft(worker, created.id, {
      ...DRAFT_DATA,
      baseRevisionId: isOtherDraftsRevision ? other.latestRevision.id : UNKNOWN_REVISION_ID,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "REVISION_NOT_FOUND" } });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test("revising an unknown Draft answers with 404 DRAFT_NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  const response = await reviseDraft(worker, UNKNOWN_DRAFT_ID, {
    ...DRAFT_DATA,
    baseRevisionId: UNKNOWN_REVISION_ID,
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "DRAFT_NOT_FOUND" } });
  expect(await readRows(worker)).toStrictEqual({ drafts: [], revisions: [] });
});

test.for([
  { name: "an unknown Revision", isOtherDraftsRevision: false },
  { name: "another Draft's Revision", isOtherDraftsRevision: true },
])(
  "revising on $name answers with 404 REVISION_NOT_FOUND and changes nothing",
  async ({ isOtherDraftsRevision }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);
    const other = await createDraft(worker);
    const rowsBefore = await readRows(worker);

    const response = await reviseDraft(worker, created.id, {
      ...DRAFT_DATA,
      baseRevisionId: isOtherDraftsRevision ? other.latestRevision.id : UNKNOWN_REVISION_ID,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "REVISION_NOT_FOUND" } });
    expect(await readRows(worker)).toStrictEqual(rowsBefore);
  },
);

test.for([
  { name: "without baseRevisionId", baseRevisionId: undefined },
  { name: "with a Draft id as baseRevisionId", baseRevisionId: UNKNOWN_DRAFT_ID },
])(
  "revising $name answers with 400 INVALID_REQUEST",
  async ({ baseRevisionId }, { expect, onTestFinished }) => {
    const worker = await useWorker({ onTestFinished });
    const created = await createDraft(worker);

    const response = await reviseDraft(worker, created.id, { ...DRAFT_DATA, baseRevisionId });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", issues: [{ path: ["baseRevisionId"] }] },
    });
  },
);

test("revising applies the limits of Draft data", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const response = await reviseDraft(worker, created.id, {
    ...DRAFT_DATA,
    subject: "Line\nbreak",
    baseRevisionId: created.latestRevision.id,
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "INVALID_REQUEST", issues: [{ path: ["subject"] }] },
  });
});

test("the Reviewer token can revise and get a Revision too", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const headers = { ...AGENT_HEADERS, Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` };

  const reviseResponse = await worker.fetch(`/api/v1/drafts/${created.id}/revisions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...REVISED_DRAFT_DATA, baseRevisionId: created.latestRevision.id }),
  });
  const getResponse = await worker.fetch(
    `/api/v1/drafts/${created.id}/revisions/${created.latestRevision.id}`,
    { headers },
  );

  expect(reviseResponse.status).toBe(201);
  expect(getResponse.status).toBe(200);
});

test("getting another Draft's Revision answers with 404 REVISION_NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const other = await createDraft(worker);

  const response = await getRevision(worker, created.id, other.latestRevision.id);

  expect(response.status).toBe(404);
  expect(await response.json()).toStrictEqual({
    error: {
      code: "REVISION_NOT_FOUND",
      message: "The Draft has no Revision with this id.",
      requestId: response.headers.get("X-Request-Id"),
    },
  });
});

test("getting an unknown Revision answers with 404 REVISION_NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const response = await getRevision(worker, created.id, UNKNOWN_REVISION_ID);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "REVISION_NOT_FOUND" } });
});

test("getting a Revision of an unknown Draft answers with 404 DRAFT_NOT_FOUND", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const response = await getRevision(worker, UNKNOWN_DRAFT_ID, created.latestRevision.id);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "DRAFT_NOT_FOUND" } });
});

test("getting a Revision by a Draft id answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const response = await getRevision(worker, created.id, created.id);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "INVALID_REQUEST", issues: [{ path: ["revisionId"] }] },
  });
});

test("10 concurrent revises on the same base: one 201, nine 409 REVISION_SUPERSEDED and exactly one new Revision", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      reviseDraft(worker, created.id, {
        ...DRAFT_DATA,
        subject: `Concurrent revise ${index}`,
        baseRevisionId: created.latestRevision.id,
      }),
    ),
  );

  const statuses = responses.map((response) => response.status);
  expect(statuses.filter((status) => status === 201)).toHaveLength(1);
  expect(statuses.filter((status) => status === 409)).toHaveLength(9);
  const losers = responses.filter((response) => response.status === 409);
  const loserBodies: unknown[] = await Promise.all(losers.map((response) => response.json()));
  expect(loserBodies).toStrictEqual(
    Array.from({ length: 9 }, () => ({
      error: expect.objectContaining({ code: "REVISION_SUPERSEDED" }),
    })),
  );
  const winner = responses.find((response) => response.status === 201);
  const revised = unsubmittedDraftSummarySchema.parse(await winner?.json());
  const { drafts, revisions } = await readRows(worker);
  expect(drafts).toMatchObject([{ id: created.id, latest_revision_id: revised.latestRevision.id }]);
  expect(revisions).toMatchObject([
    { id: created.latestRevision.id, revision_number: 1, review_status: "SUPERSEDED" },
    { id: revised.latestRevision.id, revision_number: 2, review_status: "UNSUBMITTED" },
  ]);
});

async function createDraft(worker: TestWorker): Promise<UnsubmittedDraftSummaryResponse> {
  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify(DRAFT_DATA),
  });
  return unsubmittedDraftSummarySchema.parse(await response.json());
}

async function reviseDraft(worker: TestWorker, draftId: string, revise: unknown) {
  return worker.fetch(`/api/v1/drafts/${draftId}/revisions`, {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify(revise),
  });
}

/** Revises the Draft and fails the test unless the revise succeeds. */
async function expectRevised(
  worker: TestWorker,
  draftId: string,
  draftData: typeof DRAFT_DATA,
  baseRevisionId: string,
): Promise<UnsubmittedDraftSummaryResponse> {
  const response = await reviseDraft(worker, draftId, { ...draftData, baseRevisionId });
  if (response.status !== 201) {
    throw new Error(`The revise answered with ${response.status}: ${await response.text()}`);
  }
  return unsubmittedDraftSummarySchema.parse(await response.json());
}

async function getRevision(worker: TestWorker, draftId: string, revisionId: string) {
  return worker.fetch(`/api/v1/drafts/${draftId}/revisions/${revisionId}`, {
    headers: AGENT_HEADERS,
  });
}

async function readRows(worker: TestWorker) {
  const env = await worker.getEnv();
  const [drafts, revisions] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM drafts ORDER BY id"),
    env.DB.prepare("SELECT * FROM revisions ORDER BY draft_id, revision_number"),
  ]);
  return { drafts: drafts?.results, revisions: revisions?.results };
}

/**
 * Submits the Revision and renders the Reviewer's verdict on it (a Rejection with the reason "Wrong
 * recipient"); fails the test unless both succeed.
 */
async function expectSubmittedAndDecided(
  worker: TestWorker,
  draftId: string,
  revisionId: string,
  verdict: "approval" | "rejection",
) {
  const revisionPath = `/api/v1/drafts/${draftId}/revisions/${revisionId}`;
  const submission = await worker.fetch(`${revisionPath}/submission`, {
    method: "POST",
    headers: { Authorization: AGENT_HEADERS.Authorization },
  });
  const decision = await worker.fetch(`${revisionPath}/${verdict}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(verdict === "rejection" ? { reason: "Wrong recipient" } : {}),
  });
  if (submission.status !== 200 || decision.status !== 200) {
    throw new Error(
      `The Submission answered with ${submission.status} and the ${verdict} with ${decision.status}: ${await decision.text()}`,
    );
  }
}
