import { expect, test, type Locator, type Page } from "@playwright/test";

type LocalUser = {
  displayName: string;
  email: string;
  password: string;
  role: "admin" | "uploader" | "reviewer" | "approver";
};

const adminUser: LocalUser = {
  displayName: "E2E Admin",
  email: "admin@example.com",
  password: "Superscriber!123",
  role: "admin",
};

function buildSilentWavBuffer({
  durationMs = 1_500,
  sampleRate = 8_000,
}: {
  durationMs?: number;
  sampleRate?: number;
} = {}) {
  const sampleCount = Math.max(1, Math.floor((durationMs / 1000) * sampleRate));
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

async function chooseOptionByText(select: Locator, text: string) {
  const value = await select
    .locator("option")
    .filter({ hasText: text })
    .evaluate((element) => (element as HTMLOptionElement).value);
  await select.selectOption(value);
}

async function ensureAdminExists(page: Page) {
  await page.goto("/");

  const firstRunPill = page.getByText("First-run setup required");
  if (!(await firstRunPill.isVisible())) {
    return;
  }

  await page.getByLabel("Administrator name").fill(adminUser.displayName);
  await page.getByLabel("Administrator email").fill(adminUser.email);
  await page.getByLabel(/^Password$/).fill(adminUser.password);
  await page.getByLabel("Confirm password").fill(adminUser.password);
  await page.getByRole("button", { name: "Create admin" }).click();

  await expect(page).toHaveURL(/notice=bootstrap-complete$/);
}

async function login(page: Page, user: Pick<LocalUser, "email" | "password">) {
  await page.goto("/");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/\?reason=logged-out$/);
}

async function createLocalAccount(page: Page, user: LocalUser) {
  await page.getByLabel("Name").fill(user.displayName);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByLabel("Role").selectOption(user.role);
  await page.getByRole("button", { name: "Create local account" }).click();
  await expect(
    page.getByText(`${user.displayName} can now sign in as ${user.role}.`),
  ).toBeVisible();
}

test.describe.serial("mobile review fallback", () => {
  test("keeps phone-sized review read-only after transcript generation", async ({
    browser,
    page,
  }) => {
    const unique = Date.now();
    const reviewerUser: LocalUser = {
      displayName: `Mobile Reviewer ${unique}`,
      email: `mobile-reviewer-${unique}@example.com`,
      password: "Superscriber!123",
      role: "reviewer",
    };
    const recordingTitle = `Mobile QA ${unique}`;

    // Regression: ISSUE-001 — phone-sized review exposed live editing controls
    // Found by /qa on 2026-04-30
    // Report: .gstack/qa-reports/qa-report-localhost-2026-04-30.md
    await ensureAdminExists(page);
    await login(page, adminUser);
    await createLocalAccount(page, reviewerUser);

    await page.getByLabel("Title").fill(recordingTitle);
    await page.getByLabel("Audio or video file").setInputFiles({
      name: "mobile-review.wav",
      mimeType: "audio/wav",
      buffer: buildSilentWavBuffer(),
    });
    await page.getByRole("button", { name: "Send to governed workspace" }).click();

    await expect(page).toHaveURL(/\/recordings\/[^/?]+/);
    const recordingId = page.url().match(/\/recordings\/([^/?]+)/)?.[1];
    expect(recordingId).toBeTruthy();

    await page.goto("/workspace");
    await chooseOptionByText(page.getByLabel("Recording"), recordingTitle);
    await chooseOptionByText(page.getByLabel("Assigned user"), reviewerUser.displayName);
    await page.getByRole("button", { name: "Assign recording" }).click();
    await expect(page.getByText("Recording assignment updated.")).toBeVisible();
    await logout(page);

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const mobilePage = await mobileContext.newPage();

    await login(mobilePage, reviewerUser);
    await expect(mobilePage.getByText(`Next assigned: ${recordingTitle}`)).toBeVisible();
    await mobilePage.getByRole("link", { name: "Open next assigned item" }).click();
    await expect(mobilePage).toHaveURL(new RegExp(`/recordings/${recordingId}$`));

    await expect(mobilePage.getByText("Transcript: completed")).toBeVisible({
      timeout: 90_000,
    });
    await expect(
      mobilePage.getByText(
        "Phone-sized review stays read-only. Use a wider screen to edit, submit, or approve this transcript.",
      ),
    ).toBeVisible();
    await expect(
      mobilePage.getByText(
        "Editing and approval actions are hidden on phone-sized screens to keep the review flow constrained.",
      ),
    ).toBeVisible();
    await expect(mobilePage.getByLabel("Transcript text for seg-1")).toHaveCount(0);
    await expect(mobilePage.getByRole("button", { name: "Save draft" })).toHaveCount(0);
    await expect(mobilePage.getByRole("button", { name: "Submit revision" })).toHaveCount(
      0,
    );

    await mobileContext.close();
  });
});
