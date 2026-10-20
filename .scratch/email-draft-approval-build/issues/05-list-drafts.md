# 05: List Drafts

**What to build:** Agents and the Reviewer list Drafts filtered by review and sending status, ordered and paged with a cursor; this is what the Review UI's Pending and Decided lists will use. Spec: [Lists](../../email-draft-approval/spec.md#lists).

**Blocked by:** 04 (Submit a Revision)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/6>)

- [x] `GET /api/v1/drafts` with repeatable `reviewStatus` and `sendingStatus`, `orderBy` (`createdAt` | `lastActionAt`, default `lastActionAt`), `order` (default `desc`), `limit` (default 50, max 100), `cursor`
- [x] Returns `{ items, nextCursor? }` of Draft summaries without reading R2; ties broken by `id`; uses the `(…, id)` indexes
- [x] Opaque cursor encoding the last ordering value and id; reused with different filters or ordering → 400 `INVALID_REQUEST`
- [x] Integration tests: each filter, both orders, paging across pages with ties, the Pending-list query (longest-waiting first), cursor misuse
- [x] OpenAPI and snapshot updated
