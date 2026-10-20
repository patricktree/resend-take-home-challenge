# 13: Review UI: verdicts and sending status

**What to build:** The Reviewer approves or rejects the Revision on screen, sees the email go from "Sending…" to "Sent" (or a failure), and gets a clear, never-swallowed error when the Agent changed the Draft or someone already decided it. Spec: [Verdict controls](../../email-draft-approval/spec.md#verdict-controls), [Sending status labels](../../email-draft-approval/spec.md#sending-status-labels), [Verdict errors](../../email-draft-approval/spec.md#verdict-errors), [e2e](../../email-draft-approval/spec.md#e2e).

**Blocked by:** 08 (Send through Resend), 12 (Review UI: read-only screens)

**Status:** done (<https://github.com/patricktree/resend-take-home-challenge/pull/13>)

- [x] Approve (contained), optional reason textarea, Reject (outlined); no confirmation; disabled in flight; state keyed by the loaded Revision id; after success the page stays and refetches, lists invalidated
- [x] Sending-status labels per the spec (also in the Decided list); the Draft page polls every 3 s while `QUEUED`
- [x] Inline verdict errors above the controls with the spec's messages; "Reload Draft" for `REVISION_SUPERSEDED` and `REVISION_ALREADY_DECIDED`; nothing retried or re-applied
- [x] Sending-status labels unit-tested
- [x] e2e: Approve → "Sent" through real Miniflare Queue delivery; Reject with and without reason; both stale-verdict errors; both `FAILED` wordings
- [x] Five screenshot baselines in Docker: token screen, Pending list, Draft page (Pending), Draft page after Approval ("Sent"), inline `REVISION_SUPERSEDED`
