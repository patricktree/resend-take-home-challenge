import { cloudflare } from "@cloudflare/vite-plugin";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { defineConfig, mergeConfig, type Plugin, type ViteDevServer } from "vite";

import {
  createReviewUiViteConfig,
  REVIEW_UI_BUILD_DIRECTORY,
  REVIEW_UI_DIRECTORY,
} from "@draft-approval/review-ui/vite";

const WORKER_DIRECTORY = import.meta.dirname;

export default defineConfig(({ command }) => {
  const workerConfig = defineConfig({
    envDir: WORKER_DIRECTORY,
    build: { outDir: path.join(WORKER_DIRECTORY, "dist") },
    plugins: [
      cloudflare({
        configPath: path.join(WORKER_DIRECTORY, "wrangler.jsonc"),
        // Where `wrangler d1 migrations apply --local` (`pnpm dev`) writes; the default follows
        // Vite's root, which is the Review UI's directory in development.
        persistState: { path: path.join(WORKER_DIRECTORY, ".wrangler/state") },
      }),
    ],
  });

  switch (command) {
    case "build": {
      // The Review UI builds first (Turbo); never ship the Worker without it. Its build output
      // becomes the Worker's static assets.
      fs.accessSync(path.join(REVIEW_UI_BUILD_DIRECTORY, "app/index.html"));
      return mergeConfig(workerConfig, {
        root: WORKER_DIRECTORY,
        publicDir: REVIEW_UI_BUILD_DIRECTORY,
      });
    }
    case "serve": {
      // `pnpm dev`: one dev server for the Worker and the Review UI, with hot reload.
      return mergeConfig(mergeConfig(createReviewUiViteConfig(), workerConfig), {
        plugins: [reviewUiDevServer()],
      });
    }
    default: {
      throw new Error(`Unexpected Vite command: ${String(command)}`);
    }
  }
});

/**
 * Bridges two gaps between Vite's dev server and the Worker's production `/app` serving
 * (libs/api.server/src/review-ui.ts); the production build needs neither.
 *
 * - The Worker falls back to `/app/index.html`. In development the assets binding looks for that file
 *   at `<root>/app/index.html`, ignoring Vite's `base`, so this middleware serves the Review UI's
 *   index.html, transformed by Vite, at that path.
 * - Vite's dev server injects an inline script (the React Refresh preamble) and inline `<style>`
 *   elements (CSS hot reload), which the Review UI's Content-Security-Policy blocks. This
 *   middleware allows inline scripts and styles in development only.
 */
function reviewUiDevServer(): Plugin {
  return {
    name: "draft-approval:review-ui-dev-server",
    apply: "serve",
    // Its middleware must see each request before the Cloudflare plugin's, which answers it.
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        allowInlineScriptsAndStyles(response);

        if (request.method !== "GET" || request.url !== "/app/index.html") {
          next();
          return;
        }

        void serveIndexHtml(server, response);
      });
    },
  };
}

const DEV_SERVER_CSP_ADDITIONS = {
  "script-src 'self'": "script-src 'self' 'unsafe-inline'",
  "default-src 'self'": "default-src 'self'; style-src 'self' 'unsafe-inline'",
};

async function serveIndexHtml(server: ViteDevServer, response: http.ServerResponse): Promise<void> {
  try {
    const indexHtml = await fsPromises.readFile(
      path.join(REVIEW_UI_DIRECTORY, "index.html"),
      "utf8",
    );
    const transformedIndexHtml = await server.transformIndexHtml("/index.html", indexHtml);
    response.setHeader("Content-Type", "text/html");
    response.end(transformedIndexHtml);
  } catch (error) {
    server.config.logger.error(`Failed to serve the Review UI's index.html: ${String(error)}`);
    response.statusCode = 500;
    response.end();
  }
}

/**
 * The Cloudflare plugin writes a Worker response with `writeHead(status, headers)`; this relaxes
 * the policy in `headers` on its way out.
 */
function allowInlineScriptsAndStyles(response: http.ServerResponse): void {
  const writeHead = response.writeHead.bind(response);
  response.writeHead = (...writeHeadArguments: unknown[]) => {
    for (const argument of writeHeadArguments) {
      if (isHeaderRecord(argument)) {
        relaxContentSecurityPolicy(argument);
      }
    }
    Reflect.apply(writeHead, response, writeHeadArguments);
    return response;
  };
}

function isHeaderRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relaxContentSecurityPolicy(headers: Record<string, unknown>): void {
  const policy = headers["content-security-policy"];
  if (typeof policy !== "string") {
    return;
  }

  let relaxedPolicy = policy;
  for (const [directive, relaxedDirective] of Object.entries(DEV_SERVER_CSP_ADDITIONS)) {
    relaxedPolicy = relaxedPolicy.replace(directive, relaxedDirective);
  }
  headers["content-security-policy"] = relaxedPolicy;
}
