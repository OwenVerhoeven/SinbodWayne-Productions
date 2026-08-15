import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const PROJECT_ID = "019eca4b-6800-7635-a3fc-9b8c82f25131";
const PROJECT_ROOT = `/projects/${PROJECT_ID}`;

async function signIn(
  page: Page,
  username = "TestOwner",
  password = "test-only-owner-passphrase",
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Productions", exact: true })).toBeVisible();
}

async function expectPage(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(`${PROJECT_ROOT}/${path}`);
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
  await expect(page.getByText("Project not found", { exact: true })).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test("the project is a focused four-tool creative studio", async ({ page }) => {
  await signIn(page);
  await expectPage(page, "overview", "Project Overview");

  const projectLinks = page.locator(".sidebar__nav .nav-item");
  await expect(projectLinks).toHaveCount(4);
  await expect(projectLinks).toHaveText([
    "Project Overview",
    "Idea Box",
    "The Story",
    "Screenplay",
  ]);
  await expect(page.locator(".sidebar__nav").getByText("Budget & Vendors")).toHaveCount(0);
  await expect(page.locator(".sidebar__nav").getByText("Ready to Shoot")).toHaveCount(0);

  await expect(page.getByText("Keep the path simple", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Idea Box", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Story", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Screenplay", exact: true })).toBeVisible();

  const findings = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    findings.violations.filter((item) => item.impact === "critical" || item.impact === "serious"),
  ).toEqual([]);
});

test("ideas, story and screenplay provide usable authoring workflows", async ({ page }) => {
  await signIn(page);

  await expectPage(page, "ideas", "Idea Box");
  const capturedIdea = `A station clock starts running backwards ${Date.now()}`;
  await page.getByRole("textbox", { name: "Capture a new idea", exact: true }).fill(capturedIdea);
  await page.getByRole("button", { name: "Add to box" }).click();
  await expect(page.getByText(capturedIdea, { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Working title")).toHaveValue(capturedIdea);

  await expectPage(page, "story", "The Story");
  const startStory = page.getByRole("button", { name: "Start the story" });
  if (await startStory.isVisible().catch(() => false)) await startStory.click();
  const storyBody = page.getByLabel("Story body");
  await expect(storyBody).toBeVisible();
  await storyBody.fill(
    "Mara takes the last bus north. At the empty terminus, a passenger asks for a memory the city has forgotten.",
  );
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/\d+ words/u).first()).toBeVisible();

  await expectPage(page, "screenplay", "Screenplay");
  await expect(page.getByRole("toolbar", { name: "Screenplay elements" })).toBeVisible();
  const scriptLines = page.locator(".screenplay-line textarea");
  const before = await scriptLines.count();
  const action = page.locator(".screenplay-line--action textarea").first();
  await action.fill((await action.inputValue()).trimEnd());
  await action.press("Enter");
  await expect(scriptLines).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(page.getByText("Saved", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
});

test("a viewer can open all four tools but cannot alter creative work", async ({ page }) => {
  await signIn(page, "TestViewer", "test-only-viewer-passphrase");
  await expectPage(page, "overview", "Project Overview");
  await expect(page.getByText("View-only account", { exact: true })).toBeVisible();

  await expectPage(page, "ideas", "Idea Box");
  await expect(page.getByRole("button", { name: "Add to box" })).toHaveCount(0);
  await expect(page.getByLabel("Working title")).toBeDisabled();

  await expectPage(page, "story", "The Story");
  await expect(page.getByLabel("Story body")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  await expectPage(page, "screenplay", "Screenplay");
  await expect(page.getByRole("button", { name: "Import", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create revision", exact: true })).toHaveCount(0);
  await expect(page.locator(".screenplay-line textarea").first()).toBeDisabled();
});
