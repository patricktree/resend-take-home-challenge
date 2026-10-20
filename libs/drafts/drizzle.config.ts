import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  /* Wrangler applies the SQL files of this folder (`migrations_dir` in every Wrangler config). */
  out: "./migrations",
});
