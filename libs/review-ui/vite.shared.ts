import react from "@vitejs/plugin-react";
import wyw from "@wyw-in-js/vite";
import path from "node:path";
import url from "node:url";
import { defineConfig } from "vite";

export const REVIEW_UI_DIRECTORY = url.fileURLToPath(new URL("./", import.meta.url));

/**
 * The build output. The Worker ships this directory as its static assets, so the `app/` subfolder
 * makes every request path under `/app/` equal an asset path, with no rewriting.
 */
export const REVIEW_UI_BUILD_DIRECTORY = path.join(REVIEW_UI_DIRECTORY, "dist/web");

const WYW_CONFIG_FILE = url.fileURLToPath(
  import.meta.resolve("@patricktree-stack/config-wyw-in-js/wyw-in-js.config.cjs"),
);

/** The Review UI's Vite configuration, used by its own build and by the Worker's dev server. */
export function createReviewUiViteConfig() {
  return defineConfig({
    root: REVIEW_UI_DIRECTORY,
    base: "/app/",
    build: { outDir: path.join(REVIEW_UI_BUILD_DIRECTORY, "app"), emptyOutDir: true },
    plugins: [wyw({ configFile: WYW_CONFIG_FILE, keepComments: true }), react()],
  });
}
