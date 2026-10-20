import { createApiServer, type ApiServerEnvironment } from "@draft-approval/api.server";
import { handleQueueBatch, runScheduledTasks } from "@draft-approval/drafts";

const apiServer = createApiServer();

export default {
  fetch: (request, env, context) => apiServer.fetch(request, env, context),
  queue: (batch) => handleQueueBatch(batch),
  scheduled: () => runScheduledTasks(),
} satisfies ExportedHandler<ApiServerEnvironment>;
