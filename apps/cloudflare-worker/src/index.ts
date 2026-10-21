import { createApiServer, type ApiServerEnvironment } from "@resend-challenge/api.server";
import {
  handleQueueBatch,
  runScheduledTasks,
  type SendPipelineEnvironment,
} from "@resend-challenge/email-drafts";

type WorkerEnvironment = ApiServerEnvironment & SendPipelineEnvironment;

const apiServer = createApiServer();

export default {
  fetch: (request, env, context) => apiServer.fetch(request, env, context),
  queue: (batch, env) => handleQueueBatch(batch, env),
  scheduled: (_controller, env, _context) => runScheduledTasks(env),
} satisfies ExportedHandler<WorkerEnvironment>;
