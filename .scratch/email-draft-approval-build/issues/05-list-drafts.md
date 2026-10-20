# 05: List Drafts

**What to build:** Agents and the Reviewer list Drafts filtered by review and sending status, ordered and paged with a cursor; this is what the Review UI's Pending and Decided lists will use. Spec: [Lists](../../email-draft-approval/spec.md#lists).

**Blocked by:** 04 (Submit a Revision)

**Status:** ready-for-agent

- [ ] `GET /api/v1/drafts` with repeatable `reviewStatus` and `sendingStatus`, `orderBy` (`createdAt` | `lastActionAt`, default `lastActionAt`), `order` (default `desc`), `limit` (default 50, max 100), `cursor`
- [ ] Returns `{ items, nextCursor? }` of Draft summaries without reading R2; ties broken by `id`; uses the `(…, id)` indexes
- [ ] Opaque cursor encoding the last ordering value and id; reused with different filters or ordering → 400 `INVALID_REQUEST`
- [ ] Integration tests: each filter, both orders, paging across pages with ties, the Pending-list query (longest-waiting first), cursor misuse
- [ ] OpenAPI and snapshot updated
