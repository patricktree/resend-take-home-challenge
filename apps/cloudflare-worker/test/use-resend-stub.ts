import { expect, type TestContext } from "vitest";
import { z } from "zod";

import { startResendStub, type ResendStub } from "@resend-challenge/resend-stub";

import type { TestWorker } from "#test/use-worker.ts";

/** The dummy `RESEND_API_KEY` secret of every test Worker that sends through a Resend stub. */
export const TEST_RESEND_API_KEY = "re_test-dummy-resend-api-key";

const sentDraftRowSchema = z.object({
  idempotency_key: z.string(),
  outgoing_email: z.string(),
  email_id: z.string(),
});

const outgoingEmailSchema = z.object({
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  bodyKey: z.string(),
  tags: z.array(z.object({ name: z.string(), value: z.string() })),
});

const revisionBodySchema = z.object({ plainText: z.string() });

/**
 * Starts a Resend stub (`@resend-challenge/resend-stub`) on an OS-assigned port and closes it when
 * the test finishes. Point the test Worker at it with {@link resendStubWorkerOptions}.
 *
 * Pass `onTestFinished` from the test's own context, as for `useWorker()`.
 */
export async function useResendStub({
  onTestFinished,
}: Pick<TestContext, "onTestFinished">): Promise<ResendStub> {
  const resendStub = await startResendStub();
  onTestFinished(() => resendStub.close());
  return resendStub;
}

/** The `useWorker()` options that make the Worker send through the stub at `baseUrl`. */
export function resendStubWorkerOptions(baseUrl: string) {
  return { vars: { RESEND_BASE_URL: baseUrl }, secrets: { RESEND_API_KEY: TEST_RESEND_API_KEY } };
}

/**
 * The one "exactly once" assertion: the stub's ledger holds exactly one email per `SENT` Draft,
 * under the Draft's idempotency key and with its email id, and that email is exactly the frozen
 * outgoing email with the approved Revision's body from R2 as `text`. No other email was sent.
 */
export async function expectExactlyOneEmailPerSentDraft(
  worker: TestWorker,
  resendStub: ResendStub,
): Promise<void> {
  const env = await worker.getEnv();
  const { results } = await env.DB.prepare(
    "SELECT idempotency_key, outgoing_email, email_id FROM drafts WHERE sending_status = 'SENT'",
  ).all();

  const expectedEmails = await Promise.all(
    results.map(async (row) => {
      const sentDraft = sentDraftRowSchema.parse(row);
      const { from, to, subject, bodyKey, tags } = outgoingEmailSchema.parse(
        JSON.parse(sentDraft.outgoing_email),
      );
      const bodyObject = await env.REVISION_BODIES.get(bodyKey);
      if (bodyObject === null) {
        throw new Error(`The body ${bodyKey} is missing from R2.`);
      }
      const { plainText } = revisionBodySchema.parse(JSON.parse(await bodyObject.text()));
      return {
        id: sentDraft.email_id,
        idempotencyKey: sentDraft.idempotency_key,
        email: { from, to, subject, text: plainText, tags },
      };
    }),
  );

  expect(sortByIdempotencyKey(resendStub.emails)).toStrictEqual(
    sortByIdempotencyKey(expectedEmails),
  );
}

function sortByIdempotencyKey<T extends { idempotencyKey: string | undefined }>(
  emails: readonly T[],
): T[] {
  return emails.toSorted((first, second) =>
    (first.idempotencyKey ?? "").localeCompare(second.idempotencyKey ?? ""),
  );
}
