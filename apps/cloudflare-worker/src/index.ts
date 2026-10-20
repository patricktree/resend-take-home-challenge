import { createApiServer, type ApiServerEnvironment } from "@draft-approval/api.server";
import {
  handleQueueBatch,
  runScheduledTasks,
  type SendPipelineEnvironment,
} from "@draft-approval/drafts";

type WorkerEnvironment = ApiServerEnvironment & SendPipelineEnvironment;

const apiServer = createApiServer();

export default {
  fetch: (request, env, context) => apiServer.fetch(request, env, context),
  queue: (batch, env) => handleQueueBatch(batch, env),
  scheduled: () => runScheduledTasks(),
} satisfies ExportedHandler<WorkerEnvironment>;
