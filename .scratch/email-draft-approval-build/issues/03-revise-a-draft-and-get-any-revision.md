# 03: Revise a Draft and get any Revision

**What to build:** An Agent revises a Draft against the Revision it last saw, producing a new immutable Revision, and can fetch any earlier Revision. Lost updates are refused. Spec: [Domain model](../../email-draft-approval/spec.md#3-domain-model), [Guarded batches](../../email-draft-approval/spec.md#guarded-batches), [Race outcomes](../../email-draft-approval/spec.md#race-outcomes).

**Blocked by:** 02 (Create and get a Draft)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/3>)

- [x] `POST /api/v1/drafts/{draftId}/revisions` requires `baseRevisionId`; one guarded batch supersedes an `UNSUBMITTED` base, inserts Revision N+1 and moves `latest_revision_id`; every statement carries the guard and the one that falsifies it runs last
- [x] Errors: 409 `DRAFT_APPROVED` when approved (checked first), else 409 `REVISION_SUPERSEDED` when the base is not the latest; a losing batch leaves rows unchanged
- [x] `GET /api/v1/drafts/{draftId}/revisions/{revisionId}` returns any of the Draft's Revisions with body, including Superseded ones; 404 `REVISION_NOT_FOUND` (also for another Draft's Revision)
- [x] Gated D1 test double in the email-drafts suite that holds a chosen statement until released (no hooks in production code)
- [x] revise ‖ revise on the same base: deterministic interleaving and a concurrent-requests smoke test; exactly one new Revision, the loser gets `REVISION_SUPERSEDED`
- [x] OpenAPI and snapshot updated
