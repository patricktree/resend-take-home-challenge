/**
 * The Agent's lifecycle of a Draft, shared by the MCP server instructions and the agent quickstart
 * at `/` and `/llms.txt` (libs/api.server), so that the two never describe it differently.
 */

type DescribeLifecycleOptions = {
  /** Names the HTTP operation next to each MCP tool, for readers that may use either. */
  shouldNameHttpOperations: boolean;
};

/** A step that calls the API, or one that the Agent performs outside of it. */
type LifecycleStep =
  | {
      tool: string;
      httpOperation: string;
      /** Describes the step, given how to call it: the tool, or the tool and the HTTP operation. */
      describe: (call: string) => string;
    }
  | { text: string };

const LIFECYCLE_STEPS: LifecycleStep[] = [
  {
    tool: "create_draft",
    httpOperation: "POST /api/v1/drafts",
    describe: (call) =>
      `${call} creates a Draft whose first Revision is UNSUBMITTED. Send only to the addresses your user asked for.`,
  },
  {
    tool: "submit_draft",
    httpOperation: "POST /api/v1/drafts/{draftId}/revisions/{revisionId}/submission",
    describe: (call) =>
      `${call} submits one specific Revision (the Draft's latest) for review; the Draft becomes PENDING.`,
  },
  {
    text: "Then show the Draft's `reviewUrl` to your user, the human who asked for the email, so they can review it or forward it to the Reviewer. A human Reviewer reads exactly that Revision there and approves or rejects it; you cannot approve. An Approval sends the email through Resend, with no further action by anyone.",
  },
  {
    tool: "get_draft",
    httpOperation: "GET /api/v1/drafts/{draftId}",
    describe: (call) =>
      `Poll ${call} for \`reviewStatus\`, \`lastVerdict\` (with the Rejection reason) and \`sending\` (NOT_SENT, QUEUED, SENT or FAILED).`,
  },
];

/** Describes the four steps of the lifecycle as a numbered list, one line per step. */
export function describeLifecycle({
  shouldNameHttpOperations,
}: DescribeLifecycleOptions): string[] {
  return LIFECYCLE_STEPS.map((step, index) => {
    if ("text" in step) {
      return `${index + 1}. ${step.text}`;
    }

    const call = shouldNameHttpOperations
      ? `\`${step.tool}\` (\`${step.httpOperation}\`)`
      : `\`${step.tool}\``;
    return `${index + 1}. ${step.describe(call)}`;
  });
}
