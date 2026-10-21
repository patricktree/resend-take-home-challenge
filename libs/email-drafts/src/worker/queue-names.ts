/*
 * The names of the queues the Worker consumes, as `wrangler.jsonc` declares them; the Worker's
 * `queue()` handler dispatches on them, and `apps/cloudflare-worker/test/wrangler-config.test.ts`
 * checks that every Wrangler config uses exactly these.
 */

/** The Send Queue, as named in wrangler.jsonc. */
export const SEND_QUEUE_NAME = "resend-challenge-send";

/** The Send Queue's dead-letter queue, as named in wrangler.jsonc. */
export const SEND_DLQ_NAME = "resend-challenge-send-dlq";
