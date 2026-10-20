import { createPlaywrightDockerConfig } from "@patricktree-stack/config-playwright/playwright-docker";
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const OUTPUT_DIRECTORY = "./playwright-output";

// The shared configuration runs the browsers in a Playwright Server in Docker; these settings merge
// on top of it.
export default defineConfig(createPlaywrightDockerConfig(), {
  testDir: "./test-e2e",
  // Failures must be fixed, never retried away.
  retries: 0,
  // Each test starts its own `wrangler dev`, which takes a few seconds.
  timeout: 60_000,
  outputDir: path.join(OUTPUT_DIRECTORY, "test-results"),
  // The browsers run in Docker, so a baseline must match pixel for pixel.
  expect: { toHaveScreenshot: { threshold: 0, maxDiffPixels: 0 } },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(OUTPUT_DIRECTORY, "html-report") }],
  ],
  projects: [{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } }],
  use: {
    locale: "en-US",
    timezoneId: "Europe/Vienna",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
