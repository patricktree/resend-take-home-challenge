# Binding an approval to the reviewed Revision

Type: grilling
Status: resolved
Blocked by: 05

## Question

How does the system make sure an Approval is only accepted for exactly the Draft data the Reviewer saw, and that the Reviewer gets an error if the data changed after they loaded it? Options to weigh: approving by Revision id, by a content hash, by an optimistic-concurrency version (ETag/If-Match), or a combination; what the Reviewer sees on a stale approval; how this interacts with concurrent and repeated approvals.

## Comments

- From [05](05-draft-lifecycle.md): verdicts land as a conditional `UPDATE` on the Revision's mutable review status (`WHERE review_status = 'PENDING'`); a verdict on a `SUPERSEDED` Revision must fail, and this ticket decides the error the Reviewer sees. The Approval itself triggers the Send.
- From [07](07-exactly-once-sending.md): refinement of "`from` is read from configuration at Send time": `from` is resolved from configuration when the Approval is recorded and frozen into `outgoingEmail` with the rest of the email, so every Send attempt sends identical bytes under the same idempotency key. It is still not part of what the Reviewer approves; the Demo simplifications entry should say "resolved at Approval time".

## Answer

Resolved in a grilling session with the repository owner on 2026-10-20.

### Binding

- A verdict (Approval or Rejection) names a Draft id and a Revision id, e.g. `POST /drafts/{draftId}/revisions/{revisionId}/approval`. Final paths are ticket 09's.
- It is accepted only if that Revision belongs to the Draft, is the Draft's latest Revision, and is `PENDING`, as one conditional `UPDATE ... WHERE review_status = 'PENDING'`.
- Revisions are immutable, so the Revision id identifies exactly the Draft data the Reviewer saw. No content hash and no ETag/If-Match: both would duplicate what the Revision id already guarantees.
- Approval and Rejection follow identical binding rules; rejecting a superseded Revision fails too.

### Errors

Each case has its own error code. The envelope and OpenAPI description are ticket 09's.

| Case                                                    | Code                                                                                  | HTTP |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---- |
| Revision was superseded since the Reviewer loaded it    | `REVISION_SUPERSEDED`                                                                 | 409  |
| Revision already has a verdict (same or opposite)       | `REVISION_ALREADY_DECIDED`, body carries `existingVerdict` (`APPROVED` \| `REJECTED`) | 409  |
| Revision was never submitted                            | `REVISION_NOT_SUBMITTED`                                                              | 409  |
| Unknown Draft or Revision, or Revision of another Draft | (not found)                                                                           | 404  |
| Agent revises an approved Draft                         | `DRAFT_APPROVED`                                                                      | 409  |

- A repeated identical verdict is an error, not an idempotent success (unlike a repeated Submission). It never records a second verdict or triggers a second Send.
- `REVISION_SUPERSEDED` carries only code and message, not the latest Revision: the Reviewer reloads the Draft to see it.

### What the Reviewer sees

- Every verdict error is shown; the UI never swallows one, not even when `existingVerdict` matches the intended verdict. Several humans may review at once, and the second one must clearly see that the Draft was already decided.
- `REVISION_SUPERSEDED`: the Agent changed this Draft after you opened it and your verdict was not recorded. `REVISION_ALREADY_DECIDED`: this Draft was already approved/rejected. Both offer an explicit "Reload Draft"; the UI never reloads or re-applies the verdict on its own. After reload the Draft is either pending with a new Revision (reviewed from scratch) or gone from the pending list.
- Approve and Reject are disabled while a verdict request is in flight, so a double-click does not produce a self-inflicted `REVISION_ALREADY_DECIDED`.

### Concurrency

- Revise vs. verdict race: both conditionally update the same Revision; storage serializes them and the first commit wins. Verdict first → the Agent's revise gets `DRAFT_APPROVED`; revise first → the Reviewer gets `REVISION_SUPERSEDED`.
- No review lock or lease is held while a Reviewer has a Draft open.
- Concurrent or repeated verdicts: exactly one conditional `UPDATE` succeeds; the others get `REVISION_ALREADY_DECIDED`.

### Send binding

- The Approval writes `approvedRevisionId` onto the Draft in the same transaction that sets sending status to `QUEUED`. The Send builds the email only from that Revision, never from "latest". How it is sent exactly once is ticket 07's.

### Scope of the Approval

- The Reviewer approves recipients and content (Draft data) only. `from` stays in configuration and is not snapshotted on the Revision.

### For the spec

- Demo simplifications: (1) `from` comes from configuration at Send time and is not part of what the Reviewer approves; a real deployment would snapshot the sender on the Revision and show it for review. (2) Several humans share the single preconfigured Reviewer identity, so verdicts are not attributed to a person and the "already decided" error cannot say by whom (extends the SSO/IdP entry).
- Future increments: show a diff between the Revision the Reviewer had loaded and the current one after `REVISION_SUPERSEDED`.
