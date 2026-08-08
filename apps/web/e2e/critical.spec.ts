import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const PROJECT_ID = "019eca4b-6800-7635-a3fc-9b8c82f25131";
const PROJECT_ROOT = `/projects/${PROJECT_ID}`;

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username", { exact: true }).fill("TestOwner");
  await page.getByLabel("Password", { exact: true }).fill("test-only-owner-passphrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Productions", exact: true })).toBeVisible();
}

async function expectPage(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(`${PROJECT_ROOT}/${path}`);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
  await expect(page.getByText("Project not found", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Project unavailable", { exact: true })).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("authenticated planning graph is populated and internally consistent", async ({ page }) => {
  await expectPage(page, "overview", "Production Command Centre");
  await expect(page.getByText("Gate is clear", { exact: true })).toBeVisible();
  await expect(page.getByText("19 of 19 checks passed", { exact: true })).toBeVisible();

  await expectPage(page, "readiness", "Ready to Shoot");
  await expect(page.getByRole("progressbar", { name: "Project readiness" })).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  await expect(page.getByText("overridden", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ready to Shoot issue 1", exact: true }),
  ).toBeVisible();

  const routes = [
    ["screenplay", "Screenplay"],
    ["schedules", "Schedules & Stripboards"],
    ["shoot-days", "Shoot Days"],
    ["call-sheets", "Call Sheets"],
    ["production-packs", "Production Packs"],
    ["budget", "Budget & Vendors"],
    ["legal-safety", "Legal & Safety"],
    ["equipment", "Equipment & Resources"],
    ["logistics", "Logistics"],
    ["exports-archive", "Exports & Archive"],
  ] as const;

  for (const [path, heading] of routes) await expectPage(page, path, heading);

  await expect(page.getByText("verified", { exact: true })).toBeVisible();
  await expect(page.getByText("Archive never deletes cloud data.", { exact: false })).toBeVisible();

  await expectPage(page, "overview", "Production Command Centre");
  const findings = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    findings.violations.filter((item) => item.impact === "critical" || item.impact === "serious"),
  ).toEqual([]);

  await page.goto(`/print/planning/${PROJECT_ID}/budget`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Budget report", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Sinbod Wayne Productions", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  await page.emulateMedia({ media: "print" });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});
