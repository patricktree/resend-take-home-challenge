import {
  handleQueueBatch,
  runScheduledTasks,
  type SendPipelineEnvironment,
} from "@resend-challenge/email-drafts";
import { createHttpApp, type HttpAppEnvironment } from "@resend-challenge/http-app";

type WorkerEnvironment = HttpAppEnvironment & SendPipelineEnvironment;

const httpApp = createHttpApp();

export default {
  fetch: (request, env, context) => httpApp.fetch(request, env, context),
  queue: (batch, env) => handleQueueBatch(batch, env),
  scheduled: (_controller, env, _context) => runScheduledTasks(env),
} satisfies ExportedHandler<WorkerEnvironment>;
