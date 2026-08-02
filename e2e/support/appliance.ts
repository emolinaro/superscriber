import { mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { expect, type Locator, type Page } from "@playwright/test";

export type LocalUser = {
  displayName: string;
  email: string;
  password: string;
  role: "admin" | "uploader" | "reviewer" | "approver";
};

export const adminUser: LocalUser = {
  displayName: "E2E Admin",
  email: "admin@example.com",
  password: "Superscriber!123",
  role: "admin",
};

export const uploaderUser: LocalUser = {
  displayName: "E2E Uploader",
  email: "uploader@example.com",
  password: "Superscriber!123",
  role: "uploader",
};

export const reviewerUser: LocalUser = {
  displayName: "E2E Reviewer",
  email: "reviewer@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

export const approverUser: LocalUser = {
  displayName: "E2E Approver",
  email: "approver@example.com",
  password: "Superscriber!123",
  role: "approver",
};

export const outsiderUser: LocalUser = {
  displayName: "E2E Outsider",
  email: "outsider@example.com",
  password: "Superscriber!123",
  role: "reviewer",
};

type RuntimeRoot = {
  rootDir: string;
  dbPath: string;
  uploadDir: string;
};

let sharedRecordingId = "";
let sharedRecordingTitle = "";

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

export function createFixtureFile(name: string, buffer: Buffer) {
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

export function createSilentWavFixture(name: string, durationMs = 1_500) {
  return createFixtureFile(name, buildSilentWavBuffer({ durationMs }));
}

function listRoots(parent: string, prefix: string, buildDbPath: (rootDir: string) => string) {
  try {
    return readdirSync(parent)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => join(parent, entry))
      .map((rootDir) => ({
        rootDir,
        dbPath: buildDbPath(rootDir),
      }))
      .filter(({ dbPath }) => {
        try {
          return statSync(dbPath).isFile();
        } catch {
          return false;
        }
      })
      .map(({ rootDir, dbPath }) => ({
        rootDir,
        dbPath,
        uploadDir: join(rootDir, "uploads"),
        updatedAtMs: statSync(dbPath).mtimeMs,
      }));
  } catch {
    return [] as Array<RuntimeRoot & { updatedAtMs: number }>;
  }
}

function resolveRuntimeRoot(): RuntimeRoot {
  const repoTmp = join(process.cwd(), ".tmp");
  const candidates = [
    ...listRoots(tmpdir(), "superscriber-governed.", (rootDir) => join(rootDir, "app.db")),
    ...listRoots(repoTmp, "e2e-data.", (rootDir) => join(rootDir, "superscriber.db")),
  ].sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  const latest = candidates[0];
  if (!latest) {
    throw new Error("No fresh Superscriber runtime root was found.");
  }

  return latest;
}

function withRuntimeDb<T>(run: (db: Database.Database) => T) {
  const runtime = resolveRuntimeRoot();
  const db = new Database(runtime.dbPath, { readonly: false });

  try {
    return run(db);
  } finally {
    db.close();
  }
}

export function expireUploadSession(sessionId: string) {
  const runtime = resolveRuntimeRoot();
  const uploadPath = join(runtime.uploadDir, `${sessionId}.upload`);

  withRuntimeDb((db) => {
    const staleIso = new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString();
    db.prepare(
      `update ingestion_sessions set state = ?, updated_at = ?, verification_summary = ? where id = ?`,
    ).run(
      "interrupted",
      staleIso,
      "Temporary upload expired and was cleaned up. Start a new upload session to continue.",
      sessionId,
    );
  });

  unlinkSync(uploadPath);
}

export function expireActionMode(actionModeId: string) {
  withRuntimeDb((db) => {
    db.prepare(`update admin_action_sessions set expires_at = ? where id = ?`).run(
      new Date(Date.now() - 60_000).toISOString(),
      actionModeId,
    );
  });
}

export function auditRows(recordingId: string) {
  return withRuntimeDb((db) =>
    db
      .prepare(
        `select type, detail, effective_role as effectiveRole, admin_action_session_id as adminActionSessionId, created_at as createdAt from audit_events where recording_id = ? order by created_at desc`,
      )
      .all(recordingId) as Array<{
      type: string;
      detail: string;
      effectiveRole: string | null;
      adminActionSessionId: string | null;
      createdAt: string;
    }>,
  );
}

export function assignmentRows(recordingId: string) {
  return withRuntimeDb((db) =>
    db
      .prepare(
        `select id, user_id as userId, assignment_role as assignmentRole, status, completed_revision_id as completedRevisionId from recording_assignments where recording_id = ? order by created_at desc`,
      )
      .all(recordingId) as Array<{
      id: string;
      userId: string;
      assignmentRole: string;
      status: string;
      completedRevisionId: string | null;
    }>,
  );
}

export function sharedCasefile() {
  if (!sharedRecordingId) {
    throw new Error("No shared recording has been created yet.");
  }

  return {
    recordingId: sharedRecordingId,
    title: sharedRecordingTitle,
  };
}

export async function chooseOptionByText(select: Locator, text: string) {
  const option = select.locator("option").filter({ hasText: text }).first();
  const value = await option.getAttribute("value");
  if (!value) {
    throw new Error(`Unable to resolve option value for ${text}`);
  }
  await select.selectOption(value);
}

async function accountVisible(page: Page, user: LocalUser) {
  await page.goto("/administration?section=accounts");
  const search = page.getByLabel("Search accounts");
  await search.fill("");
  await expect(search).toHaveValue("");

  return (
    (await page.getByRole("cell", { name: user.email }).isVisible().catch(() => false)) ||
    (await page.getByText(user.email).isVisible().catch(() => false))
  );
}

async function createLocalAccount(page: Page, user: LocalUser) {
  if (await accountVisible(page, user)) {
    return;
  }

  await page.getByRole("button", { name: "Create account" }).click();
  const dialog = page.getByRole("dialog", { name: "Create local account" });
  const failureAlert = dialog.getByRole("alert");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(user.displayName);
  await dialog.getByLabel("Email").fill(user.email);
  await dialog.getByLabel("Password").fill(user.password);
  await dialog.getByLabel("Role").selectOption(user.role);
  await dialog.getByRole("button", { name: "Create local account" }).click();

  await Promise.race([
    dialog.waitFor({ state: "hidden" }),
    failureAlert.waitFor({ state: "visible" }),
  ]);

  if (await dialog.isVisible()) {
    if (await accountVisible(page, user)) {
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("cell", { name: user.email })).toBeVisible();
      return;
    }

    const error = await failureAlert.textContent();
    throw new Error(`Failed to create local account ${user.email}: ${error ?? "unknown"}`);
  }

  await expect(page.getByRole("cell", { name: user.email })).toBeVisible();
}

export async function bootstrapAndLogin(page: Page, user: LocalUser): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /First-run setup|Sign in/ })).toBeVisible();

  if (await page.getByRole("heading", { name: "First-run setup" }).isVisible().catch(() => false)) {
    await page.getByLabel("Administrator name").fill(adminUser.displayName);
    await page.getByLabel("Administrator email").fill(adminUser.email);
    await page.getByLabel(/^Password$/).fill(adminUser.password);
    await page.getByLabel("Confirm password").fill(adminUser.password);
    await page.getByRole("button", { name: "Create admin" }).click();
    await expect(page).toHaveURL(/notice=bootstrap-complete/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  }

  await login(page, user);
}

export async function login(page: Page, user: LocalUser): Promise<void> {
  await page.context().clearCookies();

  const csrfResponse = await page.request.get("/api/auth/csrf");
  expect(csrfResponse.ok()).toBeTruthy();
  const csrfBody = (await csrfResponse.json()) as { csrfToken: string };

  const signInResponse = await page.request.post("/api/auth/callback/credentials?json=true", {
    form: {
      csrfToken: csrfBody.csrfToken,
      email: user.email,
      password: user.password,
      callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3105"}/workspace`,
      json: "true",
    },
  });
  expect(signInResponse.status()).toBeLessThan(400);

  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}

export async function logout(page: Page) {
  await page.context().clearCookies();
  await page.goto("/?reason=logged-out");
  await expect(page).toHaveURL(/\/?\?reason=logged-out/);
}

export async function setUploadFile(
  page: Page,
  file:
    | string
    | {
        name: string;
        mimeType: string;
        buffer: Buffer;
      },
): Promise<void> {
  await page.locator("#upload-file").setInputFiles(file);
}

export async function uploadFixture(page: Page, input: { title: string }): Promise<string> {
  sharedRecordingTitle = input.title;
  await page.goto("/ingest");
  await page.waitForLoadState("networkidle");
  await page.locator("#recording-title").click();
  await page.locator("#recording-title").pressSequentially(input.title);
  await expect(page.locator("#recording-title")).toHaveValue(input.title);
  await page.locator("#recording-language").selectOption("english");
  await expect(page.locator("#recording-language")).toHaveValue("english");
  await setUploadFile(page, {
    name: "fixture.wav",
    mimeType: "audio/wav",
    buffer: buildSilentWavBuffer(),
  });
  await expect(page.locator("#recording-title")).toHaveValue(input.title);
  await expect(page.locator("#recording-language")).toHaveValue("english");
  await page.getByRole("button", { name: "Upload file" }).click();
  await expect(page).toHaveURL(/\/recordings\/[^/?]+/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: input.title })).toBeVisible();
  sharedRecordingId = page.url().match(/\/recordings\/([^/?]+)/)?.[1] ?? "";
  expect(sharedRecordingId).not.toBe("");
  return sharedRecordingId;
}

async function assignRecording(page: Page, recordingTitle: string, user: LocalUser) {
  await page.goto("/administration?section=assignments");
  await page.getByRole("button", { name: "Assign work" }).click();
  const dialog = page.getByRole("dialog", { name: "Assign governed work" });
  await expect(dialog).toBeVisible();
  await chooseOptionByText(dialog.getByLabel("Recording", { exact: true }), recordingTitle);
  await chooseOptionByText(dialog.getByLabel("Assigned user", { exact: true }), user.displayName);
  await dialog.getByRole("button", { name: "Assign recording" }).click();
  await expect(page.getByRole("status")).toContainText("Recording assignment updated.");
}

export async function createAndAssignUsers(page: Page, recordingId: string): Promise<void> {
  await page.goto("/administration?section=accounts");
  for (const user of [uploaderUser, reviewerUser, approverUser, outsiderUser]) {
    await createLocalAccount(page, user);
  }

  await assignRecording(page, sharedRecordingTitle, reviewerUser);
  await assignRecording(page, sharedRecordingTitle, approverUser);
  await openCasefile(page, recordingId);
}

export function firstTranscriptRow(page: Page) {
  return page.getByRole("article", { name: /Transcript segment 1, / });
}

export async function currentRevisionLabel(page: Page) {
  return page.getByTestId("current-revision").textContent();
}

async function waitForTranscript(page: Page) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (await firstTranscriptRow(page).isVisible().catch(() => false)) {
      return;
    }

    await page.waitForTimeout(2_000);
    await page.reload();
  }

  await expect(firstTranscriptRow(page)).toBeVisible();
}

export async function openCasefile(page: Page, recordingId: string): Promise<void> {
  await page.goto(`/recordings/${recordingId}`);
  await expect(page).toHaveURL(new RegExp(`/recordings/${recordingId}`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

export async function openAssignedCasefile(page: Page): Promise<void> {
  await page.goto("/workspace");
  const link = page.getByRole("link", { name: sharedRecordingTitle }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/recordings\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

export async function openAssignedDraft(page: Page, user: LocalUser): Promise<void> {
  await login(page, user);
  await openCasefile(page, sharedCasefile().recordingId);
  await waitForTranscript(page);
  await expect(firstTranscriptRow(page)).toBeVisible();
}

export async function openSameDraft(page: Page): Promise<void> {
  await openCasefile(page, sharedCasefile().recordingId);
  await waitForTranscript(page);
}

export async function saveEditedDraft(page: Page, text: string): Promise<void> {
  await firstTranscriptRow(page)
    .getByRole("textbox", { name: /Transcript for segment 1, / })
    .fill(text);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".casefile-page > span[role='status']")).toContainText(
    "Draft revision saved server-side.",
  );
}

export async function completeReasonDialog(page: Page, reason: string): Promise<void> {
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason").fill(reason);
  const buttons = dialog.getByRole("button");
  const count = await buttons.count();

  for (let index = count - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index);
    const name = (await button.textContent())?.trim() ?? "";
    if (name && name !== "Cancel" && name !== "Close") {
      await button.click();
      return;
    }
  }

  throw new Error("No confirm button was found in the reason dialog.");
}

export async function openGovernanceTab(page: Page, tab: string) {
  const openButton = page.getByRole("button", { name: "Open governance" });
  if ((await openButton.count()) > 0 && (await openButton.isVisible().catch(() => false))) {
    await openButton.click();
  }

  const tabButton = page.getByRole("tab", { name: tab });
  if ((await tabButton.count()) > 0) {
    await tabButton.click();
    return;
  }

  await page.getByRole("button", { name: tab }).click();
}

export async function enterAdminActionMode(
  page: Page,
  role: "reviewer" | "approver",
  purpose: string,
) {
  await page.getByRole("button", { name: `Enter ${role} action mode` }).click();
  const dialog = page.getByRole("dialog", { name: "Enter admin action mode" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Purpose").fill(purpose);
  await dialog.getByRole("button", { name: `Enter ${role} action mode` }).last().click();
  await expect(page.getByLabel("Admin action mode")).toContainText(`Admin action mode: ${role === "reviewer" ? "Reviewer" : "Approver"}`);
}

export function actionModeIdFromUrl(page: Page) {
  return new URL(page.url()).searchParams.get("actionMode");
}

export async function supportedPhoneContext(page: Page) {
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Work" })).toBeVisible();
}

export function longTranscriptText() {
  return Array.from({ length: 18 }, (_, index) => `Long governed transcript line ${index + 1}.`).join(" ");
}

export function runtimeRootDir() {
  return resolveRuntimeRoot().rootDir;
}
