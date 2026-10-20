import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";
import { defineConfig } from "vite";

const WORKER_DIRECTORY = import.meta.dirname;

export default defineConfig({
  root: WORKER_DIRECTORY,
  envDir: WORKER_DIRECTORY,
  build: { outDir: path.join(WORKER_DIRECTORY, "dist") },
  plugins: [cloudflare({ configPath: path.join(WORKER_DIRECTORY, "wrangler.jsonc") })],
});
