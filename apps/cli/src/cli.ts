#!/usr/bin/env node
import { Command, CommanderError, Option } from "@commander-js/extra-typings";

import type { ResendChallengeClient } from "@resend-challenge/api.client";
import {
  draftDataRequestSchema,
  draftParamsSchema,
  draftReviewStatusSchema,
  listDraftsQuerySchema,
  OPENAPI_DOCUMENT_PATH,
  reviseRequestSchema,
  revisionParamsSchema,
  sendingStatusSchema,
} from "@resend-challenge/api.routes";

import { toErrorEnvelope } from "#src/cli-error.ts";
import { createClient, ENVIRONMENT_VARIABLE } from "#src/connection.ts";
import {
  formatDraft,
  formatDraftList,
  formatDraftSummary,
  formatRevision,
} from "#src/human-output.ts";
import { parseInput, readBody } from "#src/input.ts";
import { PRODUCTION_API_URL } from "#src/production.ts";

/** Commander signals help output through these codes; they are not failures. */
const HELP_ERROR_CODES = new Set(["commander.helpDisplayed", "commander.help"]);

const ROOT_HELP_FOOTER = `
Lifecycle:
  drafts create, then drafts submit; a human Reviewer approves or rejects the
  submitted Revision at its reviewUrl. Poll drafts get for the review status and
  the sending status. Agents cannot approve or send.

Environment:
  ${ENVIRONMENT_VARIABLE.TOKEN}    The Agent token (default: the public Agent token committed in this repository)
  ${ENVIRONMENT_VARIABLE.API_URL}  The API URL when --api-url is absent (default: ${PRODUCTION_API_URL})

Output:
  Human-readable by default; --json prints exactly one JSON value on stdout.
  Errors print {"error":{"code","message"}} as JSON on stderr and exit with 1.

API reference (OpenAPI 3.1): ${PRODUCTION_API_URL}${OPENAPI_DOCUMENT_PATH}`;

const program = new Command()
  .name("resend-challenge")
  .description(
    "Act as an Agent on Email Draft Approval: create, revise and submit email Drafts for a human Reviewer.",
  )
  .option(
    "--api-url <url>",
    `the API's origin; HTTPS except on localhost (default: $${ENVIRONMENT_VARIABLE.API_URL}, then ${PRODUCTION_API_URL})`,
  )
  .option("--json", "print exactly one JSON value on stdout")
  .addHelpText("after", ROOT_HELP_FOOTER)
  // These three settings are inherited by every command created below.
  .configureHelp({ showGlobalOptions: true })
  // Commander's plain-text usage errors stay silent; the `catch` around `parseAsync` at the bottom
  // prints them as the JSON error envelope instead.
  .configureOutput({ outputError: () => {} })
  // Throw instead of exiting, so that `catch` sees every usage error and every help request.
  .exitOverride();

const drafts = program
  .command("drafts")
  .description("Create, read, list, revise and submit Drafts");

drafts
  .command("create")
  .description("Create a Draft; its first Revision stays Unsubmitted until you submit it")
  .requiredOption("--to <address>", "a recipient; repeat for several", collectRepeated)
  .requiredOption("--subject <subject>", "the subject, without line breaks")
  .addOption(new Option("--body <text>", "the plain-text body").conflicts("bodyFile"))
  .option("--body-file <path>", "read the plain-text body from a file, or from stdin with -")
  .action(async (options) => {
    const draftData = parseInput(draftDataRequestSchema, {
      to: options.to,
      subject: options.subject,
      body: { plainText: await readBody(options) },
    });
    await runApiCommand((client) => client.createDraft(draftData), formatDraftSummary);
  });

drafts
  .command("get")
  .description(
    "Get a Draft with its latest Revision, including the body, the review status and the sending status",
  )
  .argument("<draftId>", "the Draft id (drf_…)")
  .action(async (draftId) => {
    const params = parseInput(draftParamsSchema, { draftId });
    await runApiCommand((client) => client.getDraft(params.draftId), formatDraft);
  });

drafts
  .command("list")
  .description("List Drafts, by default the most recent action first")
  .addOption(
    new Option(
      "--review-status <status...>",
      "only Drafts with one of these review statuses",
    ).choices(draftReviewStatusSchema.options),
  )
  .addOption(
    new Option(
      "--sending-status <status...>",
      "only Drafts with one of these sending statuses",
    ).choices(sendingStatusSchema.options),
  )
  .addOption(
    new Option("--order-by <field>", "the timestamp to order by (default: lastActionAt)").choices(
      listDraftsQuerySchema.shape.orderBy.unwrap().options,
    ),
  )
  .addOption(
    new Option("--order <direction>", "the direction of the order (default: desc)").choices(
      listDraftsQuerySchema.shape.order.unwrap().options,
    ),
  )
  .option("--limit <n>", "the page size, 1–100 (default: 50)")
  .option("--cursor <cursor>", "the cursor of the next page, from the previous page")
  .action(async (options) => {
    const query = parseInput(listDraftsQuerySchema, {
      reviewStatus: options.reviewStatus,
      sendingStatus: options.sendingStatus,
      orderBy: options.orderBy,
      order: options.order,
      limit: options.limit,
      cursor: options.cursor,
    });
    await runApiCommand((client) => client.listDrafts(query), formatDraftList);
  });

drafts
  .command("revise")
  .description(
    "Revise a Draft: create its next Revision, Unsubmitted, built on the Revision you last read",
  )
  .argument("<draftId>", "the Draft id (drf_…)")
  .requiredOption(
    "--base-revision <revisionId>",
    "the Draft's latest Revision as you last read it; a newer one fails with REVISION_SUPERSEDED",
  )
  .requiredOption("--to <address>", "a recipient; repeat for several", collectRepeated)
  .requiredOption("--subject <subject>", "the subject, without line breaks")
  .addOption(new Option("--body <text>", "the plain-text body").conflicts("bodyFile"))
  .option("--body-file <path>", "read the plain-text body from a file, or from stdin with -")
  .action(async (draftId, options) => {
    const params = parseInput(draftParamsSchema, { draftId });
    const reviseRequest = parseInput(reviseRequestSchema, {
      baseRevisionId: options.baseRevision,
      to: options.to,
      subject: options.subject,
      body: { plainText: await readBody(options) },
    });
    await runApiCommand(
      (client) => client.reviseDraft(params.draftId, reviseRequest),
      formatDraftSummary,
    );
  });

drafts
  .command("submit")
  .description(
    "Submit the Draft's latest Revision for review; a human Reviewer then approves or rejects it",
  )
  .argument("<draftId>", "the Draft id (drf_…)")
  .argument("<revisionId>", "the Revision to submit, the Draft's latest (rev_…)")
  .action(async (draftId, revisionId) => {
    const params = parseInput(revisionParamsSchema, { draftId, revisionId });
    await runApiCommand(
      (client) => client.submitRevision(params.draftId, params.revisionId),
      formatDraftSummary,
    );
  });

drafts
  .command("revision")
  .description("Get any of a Draft's Revisions, including Superseded ones, with its body")
  .argument("<draftId>", "the Draft id (drf_…)")
  .argument("<revisionId>", "the Revision id (rev_…)")
  .action(async (draftId, revisionId) => {
    const params = parseInput(revisionParamsSchema, { draftId, revisionId });
    await runApiCommand(
      (client) => client.getRevision(params.draftId, params.revisionId),
      formatRevision,
    );
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && HELP_ERROR_CODES.has(error.code)) {
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write(`${JSON.stringify(toErrorEnvelope(error))}\n`);
    process.exitCode = 1;
  }
}

/** Sends one request and prints its result, as JSON with `--json`. */
async function runApiCommand<Result>(
  sendRequest: (client: ResendChallengeClient) => Promise<Result>,
  formatHuman: (result: Result) => string,
): Promise<void> {
  const { apiUrl, json } = program.opts();
  const result = await sendRequest(createClient(apiUrl, process.env));
  process.stdout.write(`${json ? JSON.stringify(result, null, 2) : formatHuman(result)}\n`);
}

/** Collects a repeatable option such as `--to a@example.com --to b@example.com`. */
function collectRepeated(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
