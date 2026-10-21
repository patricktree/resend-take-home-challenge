# Email Draft Approval

Email Draft Approval lets Agents write emails that are sent only after a human Reviewer approves them. An Agent creates and revises a Draft and submits a specific Revision; the Reviewer approves or rejects exactly that Revision, and an approved Revision is sent through Resend once.

## Language

**Agent**:
Anything acting with the Agent credential, typically an automated client that composes Drafts; it can never render a verdict or trigger a Send.
_Avoid_: Bot, AI

**Reviewer**:
The human who holds the Reviewer credential and renders verdicts on submitted Revisions in the Review UI; the Reviewer credential is never given to an Agent.
_Avoid_: User, approver, admin

**Review UI**:
The deployed web interface where the Reviewer lists Pending Drafts, reviews them and renders verdicts; it is the only place a verdict can be rendered.
_Avoid_: Dashboard, admin panel, human interface (except when quoting the challenge)

**Draft**:
The long-lived email an agent creates and works on; it has a sequence of Revisions and sends at most one email.
_Avoid_: Email draft (in prose, fine), message

**Draft data**:
The `to` recipients, subject, and body of an email; subject and body together are its content.
_Avoid_: Payload, email data

**Revision**:
An immutable snapshot of a Draft's data; every agent change to the data produces a new Revision.
_Avoid_: Version, edit

**Submission**:
The agent's request for a human verdict on one specific Revision; a Revision is submitted at most once, and revising the Draft withdraws a pending Submission.
_Avoid_: Request for review

**Pending**:
A Draft whose latest Revision is submitted and has no verdict yet; only Pending Drafts await the Reviewer's verdict in the Review UI.
_Avoid_: Open, in review

**Decided**:
A Draft whose latest Revision has a verdict (Approval or Rejection); the Review UI lists Decided Drafts with their review and sending status. A rejected Draft stops being Decided when the Agent revises it.
_Avoid_: Done, closed, history

**Superseded**:
A Revision that was replaced by a newer Revision before it got a verdict; it can no longer be submitted or decided.
_Avoid_: Stale, outdated, withdrawn

**Approval**:
A human's verdict that one specific Revision may be sent; it covers that Revision's recipients and content, counts only while that Revision is still pending, and never carries over to another Revision.
_Avoid_: Sign-off, accept

**Rejection**:
A human's verdict that one specific Revision must not be sent, optionally with a reason; like an Approval it counts only while that Revision is still pending, and the agent may revise and resubmit.
_Avoid_: Decline, deny

**Send**:
Delivering an approved Revision through Resend; the Approval triggers it with no further action by anyone, it happens at most once per Draft, and an approved Draft is closed to further Revisions even if its Send fails. A failed Send is either rejected (the email definitely did not go out) or has an unknown outcome (it may have gone out).
_Avoid_: Dispatch, delivery
