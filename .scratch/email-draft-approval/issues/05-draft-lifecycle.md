# Draft lifecycle and states

Type: grilling
Status: resolved
Blocked by:

## Question

What are the states of a Draft and of a Revision, and which transitions are allowed by whom (Agent, Reviewer, system)? What review status and what sending status does the Agent see, and how do they relate to the internal states? Edge cases to settle: revising a pending Draft (does it withdraw the Submission?), revising after a Rejection, resubmitting an unchanged Revision, a Send that fails permanently, and whether a Draft can be abandoned.

## Answer

Resolved by grilling with Patrick on 2026-10-20.

### Review status

- A Revision's Draft data is immutable; its review status is mutable: `UNSUBMITTED` | `PENDING` | `APPROVED` | `REJECTED` | `SUPERSEDED`, plus an optional rejection reason and verdict timestamps on the Revision itself (no separate Submission or verdict records).
- A Draft's review status is its latest Revision's review status (read through the latest Revision, not stored twice).
- Creating or revising a Draft never submits it. Submission is a separate, explicit act that names a Revision id.
- Each Revision is submitted at most once and gets at most one verdict.
- Submitting a Revision that is already `PENDING` is an idempotent no-op that returns the current state. Submitting a `REJECTED` or `SUPERSEDED` Revision is an error.
- Revising is allowed until the Draft is approved, including while it is pending. The new Revision supersedes the previous latest Revision if that one was `UNSUBMITTED` or `PENDING` (same transaction); a pending Submission is thereby withdrawn and the Draft leaves the Reviewer's list until the Agent submits again.
- After a Rejection, the Agent revises and submits the new Revision. A new Revision with data identical to the rejected one is allowed.
- A verdict on a superseded Revision fails; the exact error is ticket 06's.
- The Agent sees the Draft's review status and the verdict (with reason) of the latest decided Revision; earlier verdicts stay on their Revisions.

### Sending status

- The Approval triggers the Send automatically. Neither the Agent nor the Reviewer has a send operation, and there is no undo window.
- A Draft's sending status: `NOT_SENT` → `QUEUED` → `SENT` (carries the Resend email ID) | `FAILED`. `QUEUED` means the Send is committed but Resend has not accepted it yet.
- Sending status leaves `NOT_SENT` only when the latest Revision is `APPROVED`.
- `FAILED` is terminal: the Draft stays approved and closed, nothing is re-sent, and recovery is a new Draft that goes through review again. What counts as permanent, and how many retries come first, is ticket 07's.
- v1 tracks the Send only up to Resend's acceptance. Delivery events (delivered, bounced, complained) are a Future increment.
- Review status and sending status are two independent fields. With SQL storage, `CHECK` constraints enforce the allowed combinations; status transitions are conditional `UPDATE`s on the expected current status.

### Not supported

- No Discard: a Draft cannot be abandoned and stays open until approved. "Discarding a Draft" is a Future increment.

### Conventions

- Enum values are upper snake case (`NOT_SENT`, `PENDING`).

## Comments

- From [09](09-api-surface.md): revised. Submitting a Revision that is already `PENDING` is no longer an idempotent no-op; it returns 409 `REVISION_ALREADY_SUBMITTED`, so a client retrying after a timeout learns that the first Submission went through.
