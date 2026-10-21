# Input spec (as given by the repository owner)

## Requirements

### Human Interface

- (functional) the user can list pending email drafts
- (functional) the user can open a pending email draft for review
- (functional) the user can see (retrieve) the email draft's data
- (functional) the user can approve an email draft
  - (added by the repository owner) (functional) the approval is rejected and the user is shown an error message if the email draft's data changed since the email draft was loaded
- (functional) the user can reject an email draft
- (non-functional) the human interface is accessible

### Agent Interface

- (functional) the agent can create an email draft
- (functional) the agent can retrieve an email draft's data
- (functional) the agent can revise (change) an email draft's data
- (functional) the agent can submit an email draft for approval
- (functional) the agent can retrieve an email draft's review status
- (functional) the agent can retrieve an email draft's sending status
- the agent can discover the agent interface's tools (functionalities)

### System

- the approval of an email draft is only accepted for the email draft's data the human reviewed (changes require a new approval)
- an approved email draft must be sent through the Resend API
- (functional) an agent must not be able to approve an email draft
- (functional) an agent must not be able to send an email draft without approval
- (non-functional) a repeated approval must not trigger additional email sends of the same approved draft revision
- (non-functional) a concurrent approval must not trigger additional email sends of the same approved draft revision
- (non-functional) a repeated send retry must not trigger additional email sends of the same approved draft revision
- (non-functional) a concurrent send retry must not trigger additional email sends of the same approved draft revision

### Technology

- TypeScript must be used

### Definitions

- "email draft's data": recipients and content of the email
  - "content": subject and body

### Out of Scope

- account management
  - use preconfigured credentials instead
- building an agent
  - the agent interface is _used_ by agents, no need to build an agent
