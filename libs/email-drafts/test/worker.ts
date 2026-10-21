/*
 * The test runtime's entry point (see wrangler.test.jsonc). The drafts suite calls the use cases
 * from Node on the bindings the runtime exposes, so the Worker itself serves nothing.
 */
export default {
  fetch: () => new Response("The drafts test Worker serves no requests.", { status: 404 }),
} satisfies ExportedHandler;
