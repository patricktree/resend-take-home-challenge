import { expect, test } from "./fixtures.ts";
import { createDraftData, createPendingDraft, enterToken } from "./review-ui.ts";

test("the Review UI runs under its Content-Security-Policy without a violation", async ({
  page,
  reviewEnvironment,
}) => {
  await createPendingDraft(reviewEnvironment.agentClient, createDraftData("Welcome to the team"));
  // Registered before any page script runs, so no violation goes unseen.
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { securityPolicyViolations: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  const documentResponse = await page.goto("/app/");
  await enterToken(page);
  await expect(page.getByRole("link", { name: "Welcome to the team" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect(documentResponse?.headers()["content-security-policy"]).toBe(
    "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  const violations = await page.evaluate(() =>
    "securityPolicyViolations" in window ? window.securityPolicyViolations : undefined,
  );
  expect(violations).toStrictEqual([]);
  expect(consoleErrors).toStrictEqual([]);
});
