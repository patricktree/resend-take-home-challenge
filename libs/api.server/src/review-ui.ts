import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";

import type { ApiServerHonoEnvironment } from "./api-server-environment.ts";

/**
 * The Review UI's browser hardening (spec section 7). `frame-ancestors 'none'` keeps any page from
 * framing the Approve button; the Review UI ships no inline scripts or styles.
 */
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

/** The Review UI's routes are client routes of this one document. */
const INDEX_HTML_PATH = "/app/index.html";

/**
 * Serves the Review UI's static files under `/app` from the assets binding. The Vite build places
 * them in an `app/` folder, so request paths are asset paths. The files are public: the Reviewer
 * token only ever reaches the API.
 */
export function mountReviewUi(app: Hono<ApiServerHonoEnvironment>): void {
  for (const path of ["/app", "/app/*"]) {
    app.use(path, setSecurityHeaders);
    app.get(path, (context) => serveReviewUiFile(context));
  }
}

const setSecurityHeaders = createMiddleware<ApiServerHonoEnvironment>(async (context, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    context.header(name, value);
  }
});

/** A path without a matching file gets index.html with 200, so client routes deep-link. */
async function serveReviewUiFile(context: Context<ApiServerHonoEnvironment>): Promise<Response> {
  let response = await context.env.ASSETS.fetch(context.req.raw);
  if (response.status === 404) {
    const indexHtmlUrl = new URL(INDEX_HTML_PATH, context.req.url);
    response = await context.env.ASSETS.fetch(new Request(indexHtmlUrl, context.req.raw));
  }

  // The assets binding's headers are immutable; the middlewares above add theirs.
  return new Response(response.body, response);
}
