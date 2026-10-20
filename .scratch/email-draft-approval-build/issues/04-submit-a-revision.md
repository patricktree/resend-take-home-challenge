# 04: Submit a Revision

**What to build:** An Agent submits one specific Revision for review; the Draft becomes Pending, and revising a Pending Draft withdraws the Submission. Spec: [Domain model](../../email-draft-approval/spec.md#3-domain-model), [Operations](../../email-draft-approval/spec.md#operations), [Race outcomes](../../email-draft-approval/spec.md#race-outcomes).

**Blocked by:** 03 (Revise a Draft and get any Revision)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/5>)

- [x] `POST …/revisions/{revisionId}/submission` guarded on "latest and `UNSUBMITTED`"; sets `PENDING`, `submitted_at` and `last_action_at`; 200 Draft summary
- [x] Error precedence: `DRAFT_APPROVED`, `REVISION_SUPERSEDED`, `REVISION_ALREADY_DECIDED` (with `existingVerdict`), `REVISION_ALREADY_SUBMITTED`
- [x] Revise now also supersedes a `PENDING` base Revision
- [x] submit ‖ submit and submit ‖ revise in both orders, deterministic and as concurrent requests; losers leave rows unchanged
- [x] OpenAPI (each 409 names its codes) and snapshot updated
