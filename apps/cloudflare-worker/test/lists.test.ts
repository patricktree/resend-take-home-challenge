import buffer from "node:buffer";
import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import {
  draftListSchema,
  draftSchema,
  draftSummarySchema,
  LOCAL_AGENT_TOKEN,
  LOCAL_REVIEWER_TOKEN,
  type DraftListResponse,
  type DraftSummaryResponse,
} from "@resend-challenge/api.routes";

import { useWorker, type TestWorker } from "./use-worker.ts";

const AGENT_HEADERS = {
  Authorization: `Bearer ${LOCAL_AGENT_TOKEN}`,
  "Content-Type": "application/json",
};

const DRAFT_DATA = {
  to: ["ada@example.com"],
  subject: "Quarterly report",
  body: { plainText: "Hello Ada,\n\nthe report is attached.\n" },
};

/** The 23 h between an Approval and its Send deadline. */
const SEND_DEADLINE_MILLISECONDS = 23 * 60 * 60 * 1000;

test("listing without parameters answers with every Draft summary, last action newest first", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const first = await createDraft(worker);
  const second = await createDraft(worker);
  const third = await createDraft(worker);
  await setTimestamps(worker, first.id, { lastActionAt: 3000 });
  await setTimestamps(worker, second.id, { lastActionAt: 1000 });
  await setTimestamps(worker, third.id, { lastActionAt: 2000 });

  const response = await listDrafts(worker, "");

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({
    items: [
      { ...first, lastActionAt: "1970-01-01T00:00:03.000Z" },
      { ...third, lastActionAt: "1970-01-01T00:00:02.000Z" },
      { ...second, lastActionAt: "1970-01-01T00:00:01.000Z" },
    ],
  });
});

test("each review status filter alone answers with the Drafts whose latest Revision has it", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const draftIds = await createDraftInEveryReviewStatus(worker);

  for (const [reviewStatus, draftId] of Object.entries(draftIds)) {
    const page = await expectPage(worker, `?reviewStatus=${reviewStatus}`);

    expect(page.items.map((item) => [item.id, item.reviewStatus])).toStrictEqual([
      [draftId, reviewStatus],
    ]);
  }
});

test("a Draft whose Pending Revision was superseded leaves the Pending list, and SUPERSEDED is no filter", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  await submitRevision(worker, created.id, created.latestRevision.id);
  const revised = await reviseDraft(worker, created.id, created.latestRevision.id);

  const pendingPage = await expectPage(worker, "?reviewStatus=PENDING");
  const unsubmittedPage = await expectPage(worker, "?reviewStatus=UNSUBMITTED");
  const supersededResponse = await listDrafts(worker, "?reviewStatus=SUPERSEDED");

  expect(pendingPage).toStrictEqual({ items: [] });
  expect(unsubmittedPage).toStrictEqual({ items: [revised] });
  expect(supersededResponse.status).toBe(400);
  expect(await supersededResponse.json()).toMatchObject({
    error: { code: "INVALID_REQUEST", issues: [{ path: ["reviewStatus", 0] }] },
  });
});

test("each sending status filter alone answers with the Drafts that have it", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const notSent = await createDraft(worker);
  const queued = await createDecidedDraft(worker, { verdict: "APPROVED", sending: "QUEUED" });
  const sent = await createDecidedDraft(worker, { verdict: "APPROVED", sending: "SENT" });
  const failed = await createDecidedDraft(worker, { verdict: "APPROVED", sending: "FAILED" });

  const notSentPage = await expectPage(worker, "?sendingStatus=NOT_SENT");
  const queuedPage = await expectPage(worker, "?sendingStatus=QUEUED");
  const sentPage = await expectPage(worker, "?sendingStatus=SENT");
  const failedPage = await expectPage(worker, "?sendingStatus=FAILED");

  expect(notSentPage.items.map((item) => item.id)).toStrictEqual([notSent.id]);
  expect(queuedPage.items).toMatchObject([{ id: queued, sending: { status: "QUEUED" } }]);
  expect(sentPage.items).toMatchObject([
    { id: sent, sending: { status: "SENT", emailId: `email-${sent}` } },
  ]);
  expect(failedPage.items).toMatchObject([
    { id: failed, sending: { status: "FAILED", failure: { reason: "OUTCOME_UNKNOWN" } } },
  ]);
});

test("repeated values of a filter match any of them, and different filters must all match", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const draftIds = await createDraftInEveryReviewStatus(worker);
  const sent = await createDecidedDraft(worker, { verdict: "APPROVED", sending: "SENT" });

  const decidedPage = await expectPage(worker, "?reviewStatus=APPROVED&reviewStatus=REJECTED");
  const approvedAndSentPage = await expectPage(worker, "?reviewStatus=APPROVED&sendingStatus=SENT");
  const notSentPage = await expectPage(
    worker,
    "?reviewStatus=PENDING&reviewStatus=REJECTED&sendingStatus=NOT_SENT&sendingStatus=FAILED",
  );
  const rejectedAndQueuedPage = await expectPage(
    worker,
    "?reviewStatus=REJECTED&sendingStatus=QUEUED",
  );

  expect(decidedPage.items.map((item) => item.id).toSorted()).toStrictEqual(
    [draftIds.APPROVED, draftIds.REJECTED, sent].toSorted(),
  );
  expect(approvedAndSentPage.items.map((item) => item.id)).toStrictEqual([sent]);
  expect(notSentPage.items.map((item) => item.id).toSorted()).toStrictEqual(
    [draftIds.PENDING, draftIds.REJECTED].toSorted(),
  );
  expect(rejectedAndQueuedPage).toStrictEqual({ items: [] });
});

test("a filter value repeated 200 times counts once, so a long query string stays within D1's bound parameters", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const draftIds = await createDraftInEveryReviewStatus(worker);
  const repeatedFilters = [
    ...Array.from({ length: 200 }, () => "reviewStatus=PENDING"),
    ...Array.from({ length: 200 }, () => "sendingStatus=NOT_SENT"),
  ].join("&");

  const page = await expectPage(worker, `?${repeatedFilters}`);

  expect(page.items.map((item) => item.id)).toStrictEqual([draftIds.PENDING]);
});

test("both orderings run in both directions", async ({ expect, onTestFinished }) => {
  const worker = await useWorker({ onTestFinished });
  const first = await createDraft(worker);
  const second = await createDraft(worker);
  const third = await createDraft(worker);
  await setTimestamps(worker, first.id, { createdAt: 1000, lastActionAt: 2000 });
  await setTimestamps(worker, second.id, { createdAt: 2000, lastActionAt: 3000 });
  await setTimestamps(worker, third.id, { createdAt: 3000, lastActionAt: 1000 });

  const listedIds = async (queryString: string) =>
    (await expectPage(worker, queryString)).items.map((item) => item.id);

  expect(await listedIds("?orderBy=createdAt")).toStrictEqual([third.id, second.id, first.id]);
  expect(await listedIds("?orderBy=createdAt&order=asc")).toStrictEqual([
    first.id,
    second.id,
    third.id,
  ]);
  expect(await listedIds("?orderBy=lastActionAt&order=desc")).toStrictEqual([
    second.id,
    first.id,
    third.id,
  ]);
  expect(await listedIds("?order=asc")).toStrictEqual([third.id, first.id, second.id]);
});

test("paging walks every Draft exactly once across pages, ties in the ordering value broken by id", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  // Two Drafts at 1000, three at 2000 and two at 3000, so pages start and end inside ties.
  const orderingValues = [1000, 1000, 2000, 2000, 2000, 3000, 3000];
  const idsInAscendingOrder: string[] = [];
  for (const orderingValue of orderingValues) {
    const created = await createDraft(worker);
    await setTimestamps(worker, created.id, {
      createdAt: orderingValue,
      lastActionAt: orderingValue,
    });
    // UUIDv7 ids sort by creation time, so within a tie the Drafts are in creation order.
    idsInAscendingOrder.push(created.id);
  }

  for (const orderBy of ["createdAt", "lastActionAt"]) {
    for (const order of ["asc", "desc"]) {
      const pages = await readAllPages(worker, `?orderBy=${orderBy}&order=${order}`, 2);

      expect(pages.map((page) => page.items.length)).toStrictEqual([2, 2, 2, 1]);
      expect(pages.flatMap((page) => page.items.map((item) => item.id))).toStrictEqual(
        order === "asc" ? idsInAscendingOrder : idsInAscendingOrder.toReversed(),
      );
    }
  }
});

test("a page that ends exactly with the last Draft has no nextCursor", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  await createDraft(worker);
  await createDraft(worker);

  const page = await expectPage(worker, "?limit=2");

  expect(page.items).toHaveLength(2);
  expect(page).not.toHaveProperty("nextCursor");
});

test("the Pending list answers with the longest-waiting Submission first", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const unsubmitted = await createDraft(worker);
  const waitingShortest = await createDraft(worker);
  const waitingLongest = await createDraft(worker);
  const waitingMiddle = await createDraft(worker);
  for (const [draft, submittedAt] of [
    [waitingShortest, 3000],
    [waitingLongest, 1000],
    [waitingMiddle, 2000],
  ] as const) {
    await submitRevision(worker, draft.id, draft.latestRevision.id);
    await setTimestamps(worker, draft.id, { lastActionAt: submittedAt });
  }
  await setTimestamps(worker, unsubmitted.id, { lastActionAt: 500 });

  const page = await expectPage(worker, "?reviewStatus=PENDING&order=asc");

  expect(page.items.map((item) => [item.id, item.reviewStatus])).toStrictEqual([
    [waitingLongest.id, "PENDING"],
    [waitingMiddle.id, "PENDING"],
    [waitingShortest.id, "PENDING"],
  ]);
});

test("the Decided list answers with Approved and Rejected Drafts, newest verdict first", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  await createDraft(worker);
  const pending = await createDraft(worker);
  await submitRevision(worker, pending.id, pending.latestRevision.id);
  const rejectedFirst = await createDecidedDraft(worker, { verdict: "REJECTED", decidedAt: 1000 });
  const approvedLast = await createDecidedDraft(worker, {
    verdict: "APPROVED",
    sending: "SENT",
    decidedAt: 3000,
  });
  const approvedSecond = await createDecidedDraft(worker, {
    verdict: "APPROVED",
    sending: "QUEUED",
    decidedAt: 2000,
  });

  const page = await expectPage(worker, "?reviewStatus=APPROVED&reviewStatus=REJECTED");

  expect(page.items).toMatchObject([
    {
      id: approvedLast,
      reviewStatus: "APPROVED",
      latestRevision: { decidedAt: "1970-01-01T00:00:03.000Z" },
      sending: { status: "SENT" },
    },
    { id: approvedSecond, reviewStatus: "APPROVED", sending: { status: "QUEUED" } },
    {
      id: rejectedFirst,
      reviewStatus: "REJECTED",
      latestRevision: { rejectionReason: "Too long" },
      sending: { status: "NOT_SENT" },
    },
  ]);
  expect(page.items).toHaveLength(3);
});

test("list items carry each Draft's lastVerdict, also a Rejection the Agent has since revised after", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const reviewerHeaders = { ...AGENT_HEADERS, Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` };
  const withoutVerdict = await createDraft(worker);
  await submitRevision(worker, withoutVerdict.id, withoutVerdict.latestRevision.id);
  const revisedAfterRejection = await createDraft(worker);
  const rejectedRevisionId = revisedAfterRejection.latestRevision.id;
  await submitRevision(worker, revisedAfterRejection.id, rejectedRevisionId);
  const rejection = await worker.fetch(
    `/api/v1/drafts/${revisedAfterRejection.id}/revisions/${rejectedRevisionId}/rejection`,
    { method: "POST", headers: reviewerHeaders, body: JSON.stringify({ reason: "Too long" }) },
  );
  const rejectedAt = draftSummarySchema.parse(await rejection.json()).lastActionAt;
  const revised = await reviseDraft(worker, revisedAfterRejection.id, rejectedRevisionId);
  await submitRevision(worker, revisedAfterRejection.id, revised.latestRevision.id);
  const approved = await createDraft(worker);
  await submitRevision(worker, approved.id, approved.latestRevision.id);
  const approval = await worker.fetch(
    `/api/v1/drafts/${approved.id}/revisions/${approved.latestRevision.id}/approval`,
    { method: "POST", headers: reviewerHeaders },
  );
  const approvedAt = draftSummarySchema.parse(await approval.json()).lastActionAt;

  const page = await expectPage(worker, "?orderBy=createdAt&order=asc");

  expect(page.items).toMatchObject([
    { id: withoutVerdict.id, reviewStatus: "PENDING" },
    {
      id: revisedAfterRejection.id,
      reviewStatus: "PENDING",
      latestRevision: { revisionNumber: 2 },
      lastVerdict: {
        revisionId: rejectedRevisionId,
        revisionNumber: 1,
        verdict: "REJECTED",
        reason: "Too long",
        decidedAt: rejectedAt,
      },
    },
    {
      id: approved.id,
      reviewStatus: "APPROVED",
      lastVerdict: {
        revisionId: approved.latestRevision.id,
        revisionNumber: 1,
        verdict: "APPROVED",
        decidedAt: approvedAt,
      },
      sending: { status: "QUEUED" },
    },
  ]);
  expect(page.items[0]).not.toHaveProperty("lastVerdict");
  // A list item is the Draft without the body, exactly as the Draft's own read shows it.
  const reads = await Promise.all(
    page.items.map(async (item) => {
      const response = await worker.fetch(`/api/v1/drafts/${item.id}`, { headers: AGENT_HEADERS });
      const { latestRevision, ...draft } = draftSchema.parse(await response.json());
      const { body: _body, ...latestRevisionSummary } = latestRevision;
      return { ...draft, latestRevision: latestRevisionSummary };
    }),
  );
  expect(page.items).toStrictEqual(reads);
});

test("a cursor reused with other filters or another ordering answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  for (let index = 0; index < 3; index++) {
    const created = await createDraft(worker);
    await submitRevision(worker, created.id, created.latestRevision.id);
  }
  const { nextCursor: cursor } = await expectPage(worker, "?reviewStatus=PENDING&limit=1");
  if (cursor === undefined) {
    throw new Error("The first page has no next cursor.");
  }
  const tamperedResponse = await listDrafts(worker, `?reviewStatus=PENDING&cursor=${cursor}~~`);

  expect(tamperedResponse.status).toBe(400);
  for (const otherQuery of [
    "reviewStatus=UNSUBMITTED",
    "reviewStatus=PENDING&reviewStatus=UNSUBMITTED",
    "reviewStatus=PENDING&sendingStatus=NOT_SENT",
    "",
    "reviewStatus=PENDING&orderBy=createdAt",
    "reviewStatus=PENDING&order=asc",
  ]) {
    const response = await listDrafts(worker, `?${otherQuery}&cursor=${cursor}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        issues: [{ path: ["cursor"], message: expect.any(String) }],
      },
    });
  }
});

test("a cursor that does not decode answers with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  await createDraft(worker);

  for (const cursor of [
    "garbage",
    "",
    "%%%",
    encodeBase64Url("{}"),
    encodeBase64Url('[1000,"drf_not-a-draft-id","[]"]'),
    encodeBase64Url('["1000","drf_019a0b7e-5c3d-7f2a-9b1e-4d6c8a2f0e13","[]"]'),
  ]) {
    const response = await listDrafts(worker, `?cursor=${encodeURIComponent(cursor)}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", issues: [{ path: ["cursor"] }] },
    });
  }
});

test("a cursor stays valid with the same filters in another order or repeated, and with another limit", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const draftIds = await createDraftInEveryReviewStatus(worker);
  const firstPage = await expectPage(
    worker,
    "?reviewStatus=APPROVED&reviewStatus=PENDING&reviewStatus=REJECTED&limit=1",
  );

  const restPage = await expectPage(
    worker,
    `?reviewStatus=REJECTED&reviewStatus=PENDING&reviewStatus=APPROVED&reviewStatus=PENDING&limit=5&cursor=${firstPage.nextCursor ?? ""}`,
  );

  expect([...firstPage.items, ...restPage.items].map((item) => item.id).toSorted()).toStrictEqual(
    [draftIds.PENDING, draftIds.APPROVED, draftIds.REJECTED].toSorted(),
  );
  expect(restPage).not.toHaveProperty("nextCursor");
});

test("limit defaults to 50 and must be an integer from 1 to 100", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  await insertDrafts(worker, 101);

  const defaultPage = await expectPage(worker, "");
  const smallestPage = await expectPage(worker, "?limit=1");
  const largestPage = await expectPage(worker, "?limit=100");

  expect(defaultPage.items).toHaveLength(50);
  expect(smallestPage.items).toHaveLength(1);
  expect(largestPage.items).toHaveLength(100);
  expect(largestPage.nextCursor).toStrictEqual(expect.any(String));
  for (const limit of ["0", "101", "1.5", "-1", "many", ""]) {
    const response = await listDrafts(worker, `?limit=${limit}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", issues: [{ path: ["limit"] }] },
    });
  }
});

test("invalid orderBy, order and sendingStatus values answer with 400 INVALID_REQUEST", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });

  for (const [queryString, path] of [
    ["?orderBy=submittedAt", ["orderBy"]],
    ["?order=up", ["order"]],
    ["?sendingStatus=DELIVERED", ["sendingStatus", 0]],
  ] as const) {
    const response = await listDrafts(worker, queryString);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", issues: [{ path }] },
    });
  }
});

test("listing reads no bodies: it works with every body missing from R2", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);
  const env = await worker.getEnv();
  await env.REVISION_BODIES.delete(`revisions/${created.latestRevision.id}/body`);

  const page = await expectPage(worker, "");

  expect(page).toStrictEqual({ items: [created] });
});

test("the Reviewer token can list Drafts, and the response carries a read bookmark", async ({
  expect,
  onTestFinished,
}) => {
  const worker = await useWorker({ onTestFinished });
  const created = await createDraft(worker);

  const response = await worker.fetch("/api/v1/drafts", {
    headers: { Authorization: `Bearer ${LOCAL_REVIEWER_TOKEN}` },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("X-Read-Bookmark")).toMatch(/^\S+$/);
  expect(await response.json()).toStrictEqual({ items: [created] });
});

async function createDraft(worker: TestWorker): Promise<DraftSummaryResponse> {
  const response = await worker.fetch("/api/v1/drafts", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify(DRAFT_DATA),
  });
  if (response.status !== 201) {
    throw new Error(`Creating a Draft answered with ${response.status}.`);
  }
  return draftSummarySchema.parse(await response.json());
}

async function submitRevision(
  worker: TestWorker,
  draftId: string,
  revisionId: string,
): Promise<DraftSummaryResponse> {
  const response = await worker.fetch(
    `/api/v1/drafts/${draftId}/revisions/${revisionId}/submission`,
    { method: "POST", headers: AGENT_HEADERS },
  );
  if (response.status !== 200) {
    throw new Error(`Submitting a Revision answered with ${response.status}.`);
  }
  return draftSummarySchema.parse(await response.json());
}

async function reviseDraft(
  worker: TestWorker,
  draftId: string,
  baseRevisionId: string,
): Promise<DraftSummaryResponse> {
  const response = await worker.fetch(`/api/v1/drafts/${draftId}/revisions`, {
    method: "POST",
    headers: AGENT_HEADERS,
    body: JSON.stringify({ ...DRAFT_DATA, subject: "Quarterly report, revised", baseRevisionId }),
  });
  if (response.status !== 201) {
    throw new Error(`Revising a Draft answered with ${response.status}.`);
  }
  return draftSummarySchema.parse(await response.json());
}

/**
 * Creates and submits a Draft, then records its verdict, and for an Approval its outbox and sending
 * status, directly in D1, consistent with the `CHECK`s. Returns the Draft id.
 */
async function createDecidedDraft(
  worker: TestWorker,
  {
    verdict,
    sending = "QUEUED",
    decidedAt = Temporal.Now.instant().epochMilliseconds,
  }: {
    verdict: "APPROVED" | "REJECTED";
    sending?: "QUEUED" | "SENT" | "FAILED";
    decidedAt?: number;
  },
): Promise<string> {
  const created = await createDraft(worker);
  await submitRevision(worker, created.id, created.latestRevision.id);
  const env = await worker.getEnv();
  const statements = [
    env.DB.prepare(
      "UPDATE revisions SET review_status = ?1, decided_at = ?2, rejection_reason = ?3 WHERE id = ?4",
    ).bind(
      verdict,
      decidedAt,
      verdict === "REJECTED" ? "Too long" : null,
      created.latestRevision.id,
    ),
    env.DB.prepare("UPDATE drafts SET last_action_at = ?1 WHERE id = ?2").bind(
      decidedAt,
      created.id,
    ),
  ];
  if (verdict === "APPROVED") {
    statements.push(
      env.DB.prepare(
        `UPDATE drafts SET sending_status = ?1, approved_revision_id = latest_revision_id,
          approved_at = ?2, idempotency_key = 'draft-send/' || id, outgoing_email = '{}',
          deadline = ?2 + ?3,
          email_id = CASE WHEN ?1 = 'SENT' THEN 'email-' || id END,
          failure_reason = CASE WHEN ?1 = 'FAILED' THEN 'OUTCOME_UNKNOWN' END
        WHERE id = ?4`,
      ).bind(sending, decidedAt, SEND_DEADLINE_MILLISECONDS, created.id),
    );
  }
  await env.DB.batch(statements);
  return created.id;
}

/** Creates one Draft in each review status a Draft can have; returns their ids by status. */
async function createDraftInEveryReviewStatus(
  worker: TestWorker,
): Promise<Record<"UNSUBMITTED" | "PENDING" | "APPROVED" | "REJECTED", string>> {
  const unsubmitted = await createDraft(worker);
  const pending = await createDraft(worker);
  await submitRevision(worker, pending.id, pending.latestRevision.id);
  return {
    UNSUBMITTED: unsubmitted.id,
    PENDING: pending.id,
    APPROVED: await createDecidedDraft(worker, { verdict: "APPROVED" }),
    REJECTED: await createDecidedDraft(worker, { verdict: "REJECTED" }),
  };
}

/** Inserts Unsubmitted Drafts directly in D1, for lists longer than a few Drafts. */
async function insertDrafts(worker: TestWorker, count: number): Promise<void> {
  const env = await worker.getEnv();
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < count; index++) {
    const idSuffix = index.toString(16).padStart(12, "0");
    const draftId = `drf_00000000-0000-7000-8000-${idSuffix}`;
    const revisionId = `rev_00000000-0000-7000-8000-${idSuffix}`;
    statements.push(
      env.DB.prepare(
        "INSERT INTO drafts (id, created_at, last_action_at, latest_revision_id) VALUES (?1, ?2, ?2, ?3)",
      ).bind(draftId, index, revisionId),
      env.DB.prepare(
        `INSERT INTO revisions (id, draft_id, revision_number, created_at, to_addresses, subject, review_status)
          VALUES (?1, ?2, 1, ?3, '["ada@example.com"]', 'Hello', 'UNSUBMITTED')`,
      ).bind(revisionId, draftId, index),
    );
  }
  await env.DB.batch(statements);
}

function listDrafts(worker: TestWorker, queryString: string) {
  return worker.fetch(`/api/v1/drafts${queryString}`, { headers: AGENT_HEADERS });
}

async function expectPage(worker: TestWorker, queryString: string): Promise<DraftListResponse> {
  const response = await listDrafts(worker, queryString);
  if (response.status !== 200) {
    throw new Error(`Listing with "${queryString}" answered with ${response.status}.`);
  }
  return draftListSchema.parse(await response.json());
}

/** Reads every page of a list, following `nextCursor`. */
async function readAllPages(
  worker: TestWorker,
  queryString: string,
  limit: number,
): Promise<DraftListResponse[]> {
  const pages: DraftListResponse[] = [];
  let cursor: string | undefined;
  do {
    const cursorParameter = cursor === undefined ? "" : `&cursor=${cursor}`;
    const page = await expectPage(worker, `${queryString}&limit=${limit}${cursorParameter}`);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return pages;
}

/** Backdates a Draft's ordering values, in milliseconds since the Unix epoch. */
async function setTimestamps(
  worker: TestWorker,
  draftId: string,
  { createdAt, lastActionAt }: { createdAt?: number; lastActionAt?: number },
): Promise<void> {
  const env = await worker.getEnv();
  await env.DB.prepare(
    "UPDATE drafts SET created_at = coalesce(?1, created_at), last_action_at = coalesce(?2, last_action_at) WHERE id = ?3",
  )
    .bind(createdAt ?? null, lastActionAt ?? null, draftId)
    .run();
}

function encodeBase64Url(text: string): string {
  return buffer.Buffer.from(text, "utf8").toString("base64url");
}
