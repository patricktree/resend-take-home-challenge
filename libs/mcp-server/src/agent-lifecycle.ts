/**
 * The Agent's lifecycle of a Draft, shared by the MCP server instructions and the agent quickstart
 * at `/` and `/llms.txt` (libs/http-app), so that the two never describe it differently.
 */

type DescribeLifecycleOptions = {
  /** Names the HTTP operation next to each MCP tool, for readers that may use either. */
  shouldNameHttpOperations: boolean;
};

/** An MCP tool and the HTTP operation behind it. */
type Operation = { tool: string; httpOperation: string };

/** A step that calls the API, or one that the Agent performs outside of it. */
type LifecycleStep =
  | (Operation & {
      /** Describes the step, given how to call it: the tool, or the tool and the HTTP operation. */
      describe: (call: string) => string;
    })
  | { text: string };

const OPERATION = {
  CREATE: { tool: "create_draft", httpOperation: "POST /api/v1/drafts" },
  SUBMIT: {
    tool: "submit_draft",
    httpOperation: "POST /api/v1/drafts/{draftId}/revisions/{revisionId}/submission",
  },
  GET: { tool: "get_draft", httpOperation: "GET /api/v1/drafts/{draftId}" },
  REVISE: { tool: "revise_draft", httpOperation: "POST /api/v1/drafts/{draftId}/revisions" },
} satisfies Record<string, Operation>;

const LIFECYCLE_STEPS: LifecycleStep[] = [
  {
    ...OPERATION.CREATE,
    describe: (call) =>
      `${call} creates a Draft whose first Revision is UNSUBMITTED. Send only to the addresses your user asked for.`,
  },
  {
    ...OPERATION.SUBMIT,
    describe: (call) =>
      `${call} submits one specific Revision (the Draft's latest) for review; the Draft becomes PENDING, and the result carries the Draft's \`reviewUrl\`.`,
  },
  {
    text: "Then show that `reviewUrl` to your user, the human who asked for the email, so they can review it or forward it to the Reviewer. A human Reviewer reads exactly that Revision there and approves or rejects it. An Approval sends the email through Resend, with no further action by anyone.",
  },
  {
    ...OPERATION.GET,
    describe: (call) =>
      `Poll ${call} for \`reviewStatus\`, \`lastVerdict\` (with the Rejection reason) and \`sending\` (NOT_SENT, QUEUED, SENT or FAILED). The verdict comes from a human and may take minutes or hours, so poll at intervals, not in a tight loop.`,
  },
];

/**
 * Describes the lifecycle: its four steps as a numbered list, one line per step, then a paragraph
 * on revising after a Rejection.
 */
export function describeLifecycle({
  shouldNameHttpOperations,
}: DescribeLifecycleOptions): string[] {
  const describeCall = (operation: Operation): string =>
    shouldNameHttpOperations
      ? `\`${operation.tool}\` (\`${operation.httpOperation}\`)`
      : `\`${operation.tool}\``;

  const steps = LIFECYCLE_STEPS.map(
    (step, index) =>
      `${index + 1}. ${"text" in step ? step.text : step.describe(describeCall(step))}`,
  );
  return [
    ...steps,
    "",
    `After a Rejection, revise the Draft with ${describeCall(OPERATION.REVISE)}, passing its latest Revision's id as \`baseRevisionId\`, and submit the new Revision with \`${OPERATION.SUBMIT.tool}\`. An approved Draft accepts no further Revisions.`,
  ];
}
