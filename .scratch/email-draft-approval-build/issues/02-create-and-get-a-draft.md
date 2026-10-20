# 02: Create and get a Draft

**What to build:** An Agent creates a Draft and reads it back, with its body, through the typed client. This is the first slice through contract, typed client, use case, D1 and R2. Spec: [Data model](../../email-draft-approval/spec.md#5-data-model), [HTTP API](../../email-draft-approval/spec.md#6-http-api), [Read bookmark](../../email-draft-approval/spec.md#read-bookmark).

**Blocked by:** 01 (Repository and Worker skeleton)

**Status:** ready-for-agent

- [ ] Drizzle schema for `drafts` and `revisions` with every `CHECK` and index from the spec; generated SQL migrations committed
- [ ] Prefixed UUIDv7 ids (`drf_`, `rev_`) and `revision_number`; unit-tested
- [ ] `POST /api/v1/drafts` writes the R2 body, then one batch inserting the Draft and Revision 1 (`UNSUBMITTED`); returns 201 with a Draft summary (no body)
- [ ] `GET /api/v1/drafts/{draftId}` returns the full Draft with body, `reviewStatus`, `sending`, `reviewUrl`; omitted fields are never `null`; 404 `DRAFT_NOT_FOUND`
- [ ] Validation and limits (`to` 1–50 unique valid addresses, subject 1–998 chars without line breaks, body up to 100 KB UTF-8) → 400 `INVALID_REQUEST` with `issues`; request over 128 KB → 413 `PAYLOAD_TOO_LARGE`
- [ ] D1 sessions: writes start `first-primary`, reads start from `X-Read-Bookmark`; every response returns the bookmark; the single `drizzleForSession` cast helper
- [ ] Typed client (Hono RPC wrapped in a class) keeps and resends the latest bookmark; error responses surface code, status and extras
- [ ] Both routes in OpenAPI with every status code; snapshot updated
- [ ] Integration tests through `worker.fetch` and through the typed client, including read-your-writes and every limit
