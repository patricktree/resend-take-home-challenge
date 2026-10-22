import { test } from "vitest";

import { PRODUCTION_API_URL } from "../src/production.ts";
import { readProductionVar } from "./production-config.ts";

// A constant check against the production config, without any network access.
test("the built-in API URL is the production Worker's PUBLIC_BASE_URL", async ({ expect }) => {
  expect(PRODUCTION_API_URL).toBe(await readProductionVar("PUBLIC_BASE_URL"));
});
