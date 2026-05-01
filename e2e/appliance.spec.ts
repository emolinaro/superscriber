import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const reviewerUser: LocalUser = {
  displayName: "E2E Reviewer",
  email: "reviewer@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const approverUser: LocalUser = {
  displayName: "E2E Approver",
  email: "approver@example.com",
  password: "Superscriber!123",
  role: "approver",
};

const outsiderUser: LocalUser = {
  displayName: "E2E Outsider",
  email: "outsider@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

const recordingTitle = "E2E Interview 042";

let createdRecordingId = "";

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

function createFixtureFile(name: string, buffer: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), "superscriber-e2e-"));
  const path = join(directory, name);
  writeFileSync(path, buffer);

  return {
    name,
    path,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
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

async function expectAdminWorkspace(page: Page) {
  await expect(page.locator("h1.workspace-title")).toHaveText(
    "Institutional oversight workspace",
  );
}

test.describe.serial("single-image appliance", () => {
  test("bootstraps local auth and surfaces wrong-password recovery", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("First-run setup required")).toBeVisible();

    await page.getByLabel("Administrator name").fill(adminUser.displayName);
    await page.getByLabel("Administrator email").fill(adminUser.email);
    await page.getByLabel(/^Password$/).fill(adminUser.password);
    await page.getByLabel("Confirm password").fill(adminUser.password);
    await page.getByRole("button", { name: "Create admin" }).click();

    await expect(page).toHaveURL(/notice=bootstrap-complete$/);
    await expect(
      page.getByText(
        "First-run setup is complete. Sign in with the admin account you just created.",
      ),
    ).toBeVisible();

    await page.getByLabel("Email").fill(adminUser.email);
    await page.getByLabel("Password").fill("incorrect-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByText("Wrong email or password. Check the details and try again."),
    ).toBeVisible();

    await login(page, adminUser);
    await expectAdminWorkspace(page);

    await createLocalAccount(page, reviewerUser);
    await createLocalAccount(page, approverUser);
    await createLocalAccount(page, outsiderUser);

    await logout(page);
    await expect(
      page.getByText("Your session ended safely. Sign in again when you want to continue."),
    ).toBeVisible();
  });

  test("redirects expired sessions back through local sign-in", async ({ page }) => {
    await ensureAdminExists(page);
    await login(page, adminUser);
    await expectAdminWorkspace(page);

    await page.context().clearCookies();
    await page.goto("/workspace");

    await expect(page).toHaveURL(/\/\?reason=session-expired$/);
    await expect(page.getByText("Session expired. Sign in again to continue.")).toBeVisible();

    await login(page, adminUser);
    await expectAdminWorkspace(page);
  });

  test("uploads, assigns, reviews, denies unassigned access, and approves", async ({
    page,
  }) => {
    await login(page, adminUser);

    await page.getByLabel("Title").fill(recordingTitle);
    await page.getByLabel("Audio or video file").setInputFiles({
      name: "fixture.wav",
      mimeType: "audio/wav",
      buffer: buildSilentWavBuffer(),
    });
    await page.getByRole("button", { name: "Send to governed workspace" }).click();

    await expect(page).toHaveURL(/\/recordings\/[^/?]+/);
    await expect(
      page.getByText("Upload received and queued for governed verification."),
    ).toBeVisible();

    createdRecordingId = page.url().match(/\/recordings\/([^/?]+)/)?.[1] || "";
    expect(createdRecordingId).not.toBe("");

    await page.goto("/workspace");
    await chooseOptionByText(page.getByLabel("Recording"), recordingTitle);
    await chooseOptionByText(page.getByLabel("Assigned user"), reviewerUser.displayName);
    await page.getByRole("button", { name: "Assign recording" }).click();
    await expect(page.getByText("Recording assignment updated.")).toBeVisible();

    await chooseOptionByText(page.getByLabel("Recording"), recordingTitle);
    await chooseOptionByText(page.getByLabel("Assigned user"), approverUser.displayName);
    await page.getByRole("button", { name: "Assign recording" }).click();
    await expect(page.getByText("Recording assignment updated.")).toBeVisible();

    await logout(page);

    await login(page, reviewerUser);
    await expect(page.getByText(`Next assigned: ${recordingTitle}`)).toBeVisible();
    await page.getByRole("link", { name: "Open next assigned item" }).click();
    await expect(page).toHaveURL(new RegExp(`/recordings/${createdRecordingId}$`));

    await expect(page.locator("#review-segments")).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("#review-turns")).toHaveCount(0);

    const firstSegmentRow = page.locator(
      '#review-segments [data-review-segment-id="seg-1"]',
    );
    await expect(firstSegmentRow).toBeVisible();
    await expect(firstSegmentRow.getByLabel("Speaker label for seg-1")).toBeVisible();
    await expect(firstSegmentRow.getByLabel("Transcript text for seg-1")).toContainText(
      "Fallback transcript generated",
    );
    await expect(
      firstSegmentRow.getByRole("button", { name: /Jump to .* for / }),
    ).toBeVisible();

    const firstTranscriptField = page.getByLabel("Transcript text for seg-1");
    await expect(firstTranscriptField).toBeVisible({ timeout: 90_000 });
    await expect(firstTranscriptField).toContainText("Fallback transcript generated");
    await firstTranscriptField.fill(
      "Reviewer adjusted the fallback transcript inside the governed workspace.",
    );
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft revision saved server-side.")).toBeVisible();
    await page.getByRole("button", { name: "Submit revision" }).click();
    await expect(page.getByText("Revision submitted for approval.")).toBeVisible();
    await logout(page);

    await login(page, outsiderUser);
    await page.goto(`/recordings/${createdRecordingId}`);
    await expect(page).toHaveURL(/\/workspace\?error=/);
    await expect(
      page.getByText("This recording is not assigned to your account."),
    ).toBeVisible();
    await logout(page);

    await login(page, approverUser);
    await expect(page.getByText(`Next assigned: ${recordingTitle}`)).toBeVisible();
    await page.getByRole("link", { name: "Open next assigned item" }).click();
    await expect(page).toHaveURL(new RegExp(`/recordings/${createdRecordingId}$`));
    await page.getByRole("button", { name: "Approve current revision" }).click();
    await expect(
      page.getByText("Transcript approved and locked under policy."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Export approved text" })).toBeVisible();
  });

  test("resumes an interrupted upload from the last committed chunk", async ({ page }) => {
    await ensureAdminExists(page);
    await login(page, adminUser);

    const interruptedFixture = createFixtureFile(
      "interrupted-resume.wav",
      buildSilentWavBuffer({ durationMs: 80_000 }),
    );

    let chunkRequestCount = 0;
    await page.route("**/api/ingest/sessions/*/chunk", async (route) => {
      chunkRequestCount += 1;
      if (chunkRequestCount === 2) {
        await route.abort("failed");
        return;
      }

      await route.continue();
    });

    try {
      await page.getByLabel("Title").fill("Interrupted upload 007");
      await page.getByLabel("Audio or video file").setInputFiles(interruptedFixture.path);
      await page.getByRole("button", { name: "Send to governed workspace" }).click();

      await expect(
        page.getByText(/Choose the same file again to resume or restart safely\./),
      ).toBeVisible();

      await page.reload();
      await expect(
        page.getByText(
          `Resumable upload found for ${interruptedFixture.name}. Choose the same file and continue from 1.0 MB.`,
        ),
      ).toBeVisible();

      await page.getByLabel("Audio or video file").setInputFiles(interruptedFixture.path);
      await page.getByRole("button", { name: "Send to governed workspace" }).click();

      await expect(page).toHaveURL(/\/recordings\/[^/?]+/);
      await expect(
        page.getByText("Upload received and queued for governed verification."),
      ).toBeVisible();
    } finally {
      await page.unroute("**/api/ingest/sessions/*/chunk");
      interruptedFixture.cleanup();
    }
  });
});
