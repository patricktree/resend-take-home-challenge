import type { SendQueue } from "../send/send-queue.ts";

/** The Worker bindings, vars and secrets the Send pipeline reads. */
export type SendPipelineEnvironment = {
  DB: D1Database;
  REVISION_BODIES: R2Bucket;
  /** Resend's API origin; tests point it at a stub. */
  RESEND_BASE_URL: string;
  /** A secret; a Worker without it retries every Send until the deadline ends it. */
  RESEND_API_KEY?: string;
};

/** The Worker bindings the Send reconciler reads. */
export type SendReconcilerEnvironment = {
  DB: D1Database;
  /** The Send Queue's producer binding; the reconciler re-enqueues lost hand-offs to it. */
  SEND_QUEUE: SendQueue;
};
