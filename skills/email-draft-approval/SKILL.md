---
name: email-draft-approval
description: Sends an email that needs human approval through the Email Draft Approval service at resend-challenge.patricktree.me. Use when asked to send or draft an email through that service, or to follow up on one of its Drafts.
---

# Email Draft Approval

You compose an email Draft; a human Reviewer approves or rejects the exact Revision you submitted, and only an approved Revision is sent, at most once. You create, revise and submit Drafts; the Reviewer's Approval triggers the Send.

## Connect

The service's origin is `https://resend-challenge.patricktree.me`, unless your user names another one (local development uses `http://localhost:5173`). The repository owner hands out the Agent token; ask your user for it when you do not have it or it gets 401, and never guess one. `GET <origin>/llms.txt` shows the exact connection commands, and in local development also the local Agent token.

1. **MCP**, preferred: Streamable HTTP at `<origin>/mcp`, with `Authorization: Bearer <Agent token>` as a static header and no OAuth; in Codex, `codex mcp add resend-challenge --url <origin>/mcp --bearer-token-env-var RESEND_CHALLENGE_TOKEN` with the token in that environment variable. The tools are `create_draft`, `submit_draft`, `get_draft`, `list_drafts`, `revise_draft` and `get_revision`.
2. **HTTP API**, the fallback: the same header on every request under `<origin>/api/v1`. `<origin>/api/openapi.json` describes every operation; a tool's HTTP twin is named below in parentheses.
3. **CLI**, only inside a checkout of the service's repository, with nothing but Node 24: `node apps/cli/bundle/resend-challenge.mjs --help`.

## Workflow

1. **Create** the Draft with `create_draft` (`POST /api/v1/drafts`): `to`, `subject` and `body.plainText`. Create is not idempotent: after a timeout or a lost response, look for the Draft with `list_drafts` (`GET /api/v1/drafts`) before creating it again.
2. **Submit** the Draft's latest Revision with `submit_draft` (`POST /api/v1/drafts/{draftId}/revisions/{revisionId}/submission`), passing `latestRevision.id`. The Draft becomes `PENDING`.
3. **Hand over** the Draft's `reviewUrl` to your user, the human who asked for the email, so they can review it or forward it to the Reviewer. Tell them the email goes out only after an Approval.
4. **Poll** `get_draft` (`GET /api/v1/drafts/{draftId}`) every 10 to 30 seconds, backing off toward the longer interval. After about 15 minutes without a verdict, stop polling, tell your user the Draft is still pending at its `reviewUrl`, and resume when they ask.
5. **React** to the verdict in `reviewStatus`:
   - `REJECTED`: read `lastVerdict.reason`, revise with `revise_draft` (`POST /api/v1/drafts/{draftId}/revisions`) passing the latest Revision's id as `baseRevisionId`, then go back to step 2 with the new Revision. When the reason is unclear, ask your user how to revise.
   - `APPROVED`: keep polling until `sending.status` is `SENT` (report success with `sending.emailId`) or `FAILED` (see below). `QUEUED` means the Send is still in progress.

The workflow is done when `sending.status` is `SENT` or `FAILED` and your user knows which, or when you have handed a still-pending Draft back to your user.

## Rules

- Report the email as sent only once `sending.status` is `SENT`; until then, it is pending review or queued.
- Leave every verdict to the Reviewer, even when your user asks you to approve: no tool or token of yours can approve, and the Agent token on a verdict route gets `403 REVIEWER_ONLY`.
- Address an email only to recipients your user named; in the demo, that is `delivered@resend.dev`.

## Errors that need a specific reaction

A failed MCP call is a tool error with `{ error: { code, message, requestId, ... } }`; the HTTP API answers with the same envelope.

| Code or state                                       | Meaning                                                 | Reaction                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `REVISION_SUPERSEDED`                               | A newer Revision exists.                                | Read the Draft again with `get_draft`, and build on or submit its latest Revision.                                                      |
| `REVISION_ALREADY_SUBMITTED`                        | An earlier attempt of the same Submission went through. | Treat the Submission as done; continue with step 3.                                                                                     |
| `REVISION_ALREADY_DECIDED`                          | The Revision has a verdict, given in `existingVerdict`. | On a Rejection, revise first; on an Approval, follow `sending.status`.                                                                  |
| `DRAFT_APPROVED`                                    | The Draft is approved and accepts no further Revisions. | Follow `sending.status`. For a different email, create a new Draft only if your user asks.                                              |
| `FAILED` with `failure.reason` `REJECTED_BY_RESEND` | The email was definitely not sent.                      | Tell your user, with `failure.resendErrorMessage`. A new Draft is safe once they want one.                                              |
| `FAILED` with `failure.reason` `OUTCOME_UNKNOWN`    | The email may have been sent.                           | Tell your user it may have gone out, and create a new Draft only when they confirm it did not (for example, from the Resend dashboard). |
