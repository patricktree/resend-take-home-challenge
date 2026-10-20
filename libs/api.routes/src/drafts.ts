import { z } from "@hono/zod-openapi";

export type DraftDataRequest = z.input<typeof draftDataRequestSchema>;

export type DraftSummaryResponse = z.infer<typeof draftSummarySchema>;

export type DraftResponse = z.infer<typeof draftSchema>;

export type ReviseRequest = z.input<typeof reviseRequestSchema>;

export type RevisionResponse = z.infer<typeof revisionSchema>;

/** The parameters of a list; every one is optional. */
export type ListDraftsQuery = Partial<z.output<typeof listDraftsQuerySchema>>;

export type DraftListResponse = z.infer<typeof draftListSchema>;

/** Resend's maximum number of recipients per email. */
const MAX_RECIPIENTS = 50;

/** RFC 5322's line limit; a longer subject needs folding, which clients handle badly. */
const MAX_SUBJECT_LENGTH = 998;

/** The Reviewer must read the whole body before approving; Gmail clips messages over about 102 KB. */
const MAX_BODY_UTF8_BYTES = 100 * 1024;

const DRAFT_ID_PATTERN = /^drf_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The page size of a list when `limit` is absent, and its maximum. */
const LIST_LIMIT = { DEFAULT: 50, MAX: 100 } as const;

const REVISION_ID_PATTERN = /^rev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const timestampSchema = z.iso.datetime().openapi({ description: "ISO 8601 UTC timestamp" });

const draftIdSchema = z.string().regex(DRAFT_ID_PATTERN, "Must be a Draft id (drf_…).").openapi({
  description: "A Draft id: `drf_` followed by a UUIDv7",
  example: "drf_019a0b7e-5c3d-7f2a-9b1e-4d6c8a2f0e13",
});

const revisionIdSchema = z
  .string()
  .regex(REVISION_ID_PATTERN, "Must be a Revision id (rev_…).")
  .openapi({
    description: "A Revision id: `rev_` followed by a UUIDv7",
    example: "rev_019a0b7e-5c3d-7f2a-9b1e-4d6c8a2f0e14",
  });

/** The verdict of an Approval or a Rejection. */
export const verdictSchema = z.enum(["APPROVED", "REJECTED"]);

const revisionReviewStatusSchema = z
  .enum(["UNSUBMITTED", "PENDING", "APPROVED", "REJECTED", "SUPERSEDED"])
  .openapi("RevisionReviewStatus");

/** A Draft's review status is its latest Revision's, which is never Superseded. */
export const draftReviewStatusSchema = z
  .enum(["UNSUBMITTED", "PENDING", "APPROVED", "REJECTED"])
  .openapi("DraftReviewStatus");

const recipientsSchema = z
  .array(z.email("Must be a valid email address."))
  .min(1, "Needs at least one recipient.")
  .max(MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients.`)
  .refine(
    (addresses) =>
      new Set(addresses.map((address) => address.toLowerCase())).size === addresses.length,
    "Recipients must not repeat (compared case-insensitively).",
  );

// Counts characters (code points) like JSON Schema's `maxLength`, not UTF-16 code units.
const subjectSchema = z
  .string()
  .min(1, "Must not be empty.")
  .refine(
    (subject) => countCodePoints(subject) <= MAX_SUBJECT_LENGTH,
    `At most ${MAX_SUBJECT_LENGTH} characters.`,
  )
  .refine((subject) => !/[\r\n]/.test(subject), "Must not contain line breaks.")
  .openapi({ maxLength: MAX_SUBJECT_LENGTH });

const plainTextSchema = z
  .string()
  .min(1, "Must not be empty.")
  .refine(
    (plainText) => new TextEncoder().encode(plainText).byteLength <= MAX_BODY_UTF8_BYTES,
    `At most ${MAX_BODY_UTF8_BYTES} bytes in UTF-8.`,
  );

const draftDataFields = {
  to: recipientsSchema.openapi({
    description: `1–${MAX_RECIPIENTS} recipient addresses, without duplicates`,
  }),
  subject: subjectSchema.openapi({
    description: `1–${MAX_SUBJECT_LENGTH} characters, without line breaks`,
  }),
  body: z.strictObject({
    plainText: plainTextSchema.openapi({
      description: `The plain-text body, 1 character to ${MAX_BODY_UTF8_BYTES} bytes in UTF-8`,
    }),
  }),
};

/** Draft data in requests: the `to` recipients, subject and body of an email. */
export const draftDataRequestSchema = z.strictObject(draftDataFields).openapi("DraftData");

/**
 * Draft data of the next Revision and the Revision it builds on. It repeats the Draft data fields
 * rather than extending `DraftData`: OpenAPI would render the extension as an `allOf` of two
 * objects that each forbid the other's properties, which no request satisfies.
 */
export const reviseRequestSchema = z
  .strictObject({
    ...draftDataFields,
    baseRevisionId: revisionIdSchema.openapi({
      description:
        "The Revision this change builds on: the Draft's latest Revision as you last read it",
    }),
  })
  .openapi("ReviseRequest");

export const draftParamsSchema = z.object({
  draftId: draftIdSchema.openapi({ param: { name: "draftId", in: "path" } }),
});

export const revisionParamsSchema = draftParamsSchema.extend({
  revisionId: revisionIdSchema.openapi({ param: { name: "revisionId", in: "path" } }),
});

const revisionBodySchema = z.object({ plainText: z.string() }).openapi("RevisionBody");

/** A Revision without its body. */
const revisionSummarySchema = z
  .object({
    id: revisionIdSchema,
    revisionNumber: z
      .int()
      .min(1)
      .openapi({ description: "1-based number of the Revision within its Draft" }),
    createdAt: timestampSchema,
    to: z.array(z.string()),
    subject: z.string(),
    reviewStatus: revisionReviewStatusSchema,
    submittedAt: timestampSchema
      .optional()
      .openapi({ description: "When the Revision was submitted" }),
    decidedAt: timestampSchema
      .optional()
      .openapi({ description: "When the Revision got its verdict" }),
    rejectionReason: z
      .string()
      .optional()
      .openapi({ description: "The reason of a Rejection, when given" }),
  })
  .openapi("RevisionSummary");

/** A Revision with its body; Get Revision returns it for any of the Draft's Revisions. */
export const revisionSchema = revisionSummarySchema
  .extend({ body: revisionBodySchema })
  .openapi("Revision");

const lastVerdictSchema = z
  .object({
    revisionId: revisionIdSchema,
    revisionNumber: z.int().min(1),
    verdict: verdictSchema,
    reason: z.string().optional().openapi({ description: "The reason of a Rejection, when given" }),
    decidedAt: timestampSchema,
  })
  .openapi("LastVerdict", {
    description: "The newest verdict on any of the Draft's Revisions; absent while there is none",
  });

const sendingFailureSchema = z
  .object({
    reason: z.enum(["REJECTED_BY_RESEND", "OUTCOME_UNKNOWN"]).openapi({
      description:
        "`REJECTED_BY_RESEND`: the email was definitely not sent. `OUTCOME_UNKNOWN`: it may have been sent; check the Resend dashboard before creating a new Draft.",
    }),
    resendErrorName: z.string().optional().openapi({ description: "With `REJECTED_BY_RESEND`" }),
    resendErrorMessage: z.string().optional().openapi({ description: "With `REJECTED_BY_RESEND`" }),
  })
  .openapi("SendingFailure");

export const sendingStatusSchema = z
  .enum(["NOT_SENT", "QUEUED", "SENT", "FAILED"])
  .openapi("SendingStatus");

const sendingSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("NOT_SENT") }).openapi({ description: "No Approval yet" }),
    z.object({ status: z.literal("QUEUED") }).openapi({
      description: "Approved; Resend has not accepted the email yet",
    }),
    z.object({ status: z.literal("SENT"), emailId: z.string() }).openapi({
      description: "Resend accepted the email",
    }),
    z.object({ status: z.literal("FAILED"), failure: sendingFailureSchema }).openapi({
      description: "The Send ended without acceptance",
    }),
  ])
  .openapi("Sending");

const draftSummaryFields = {
  id: draftIdSchema,
  createdAt: timestampSchema,
  lastActionAt: timestampSchema.openapi({
    description: "The last create, revise, submit or verdict; never a Send outcome",
  }),
  reviewStatus: draftReviewStatusSchema,
  lastVerdict: lastVerdictSchema.optional(),
  sending: sendingSchema,
  reviewUrl: z.url().openapi({
    description: "The Draft's page in the Review UI; it grants nothing without the Reviewer token",
  }),
};

/** The Draft without the latest Revision's body; lists and every mutation return it. */
export const draftSummarySchema = z
  .object({ ...draftSummaryFields, latestRevision: revisionSummarySchema })
  .openapi("DraftSummary");

/** The Draft with the latest Revision's body; only the reads by id return it. */
export const draftSchema = z
  .object({ ...draftSummaryFields, latestRevision: revisionSchema })
  .openapi("Draft");

/** The parameters of a list: filters, ordering and paging. */
export const listDraftsQuerySchema = z.object({
  reviewStatus: repeatableQueryParameter(draftReviewStatusSchema)
    .optional()
    .openapi({
      param: { name: "reviewStatus", in: "query" },
      description:
        "Only Drafts with one of these review statuses, the latest Revision's; repeat the parameter for several. A Draft's review status is never `SUPERSEDED`.",
    }),
  sendingStatus: repeatableQueryParameter(sendingStatusSchema)
    .optional()
    .openapi({
      param: { name: "sendingStatus", in: "query" },
      description:
        "Only Drafts with one of these sending statuses; repeat the parameter for several.",
    }),
  orderBy: z
    .enum(["createdAt", "lastActionAt"])
    .default("lastActionAt")
    .openapi({
      param: { name: "orderBy", in: "query" },
      description: "The timestamp to order by; ties are broken by the Draft id.",
    }),
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .openapi({ param: { name: "order", in: "query" }, description: "The direction of the order." }),
  limit: z.coerce
    .number<string>()
    .int()
    .min(1)
    .max(LIST_LIMIT.MAX)
    .default(LIST_LIMIT.DEFAULT)
    .openapi({ param: { name: "limit", in: "query" }, description: "The page size." }),
  cursor: z
    .string()
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" },
      description:
        "The `nextCursor` of the previous page, to read the next one. It is opaque and valid only with the same filters and ordering; `limit` may change.",
    }),
});

/** A page of a list; `nextCursor` is present only while another page follows. */
export const draftListSchema = z
  .object({
    items: z.array(draftSummarySchema),
    nextCursor: z.string().optional().openapi({
      description: "Pass it as `cursor` to read the next page; absent on the last page",
    }),
  })
  .openapi("DraftList");

/**
 * Hono hands a query parameter that occurs once to the schema as a string and one that repeats as
 * an array, so a repeatable parameter wraps a single value in an array first.
 */
function repeatableQueryParameter<T extends z.ZodType>(itemSchema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z.array(itemSchema),
  );
}

function countCodePoints(text: string): number {
  return text.match(/./gsu)?.length ?? 0;
}
