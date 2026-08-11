import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

export function buildSilentWavBuffer({
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

function describeFsError(error: unknown): string {
  const errno = error as NodeJS.ErrnoException | undefined;
  if (errno?.code) {
    return `${errno.code}: ${errno.message}`;
  }
  return String(error);
}

type RootScan = {
  roots: Array<RuntimeRoot & { updatedAtMs: number }>;
  errors: string[];
};

function listRoots(parent: string, prefix: string, buildDbPath: (rootDir: string) => string): RootScan {
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch (error) {
    return { roots: [], errors: [`${parent}: ${describeFsError(error)}`] };
  }

  const roots: RootScan["roots"] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const rootDir = join(parent, entry);
    const dbPath = buildDbPath(rootDir);
    let stats;
    try {
      stats = statSync(dbPath);
    } catch (error) {
      // Surface unreadable candidates (for example EACCES from a container-owned
      // data dir on Linux CI) instead of silently dropping them.
      errors.push(`${dbPath}: ${describeFsError(error)}`);
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    roots.push({
      rootDir,
      dbPath,
      uploadDir: join(rootDir, "uploads"),
      updatedAtMs: stats.mtimeMs,
    });
  }

  return { roots, errors };
}

function resolveRuntimeRoot(): RuntimeRoot {
  const repoTmp = join(process.cwd(), ".tmp");
  const scans = [
    listRoots(tmpdir(), "superscriber-governed.", (rootDir) => join(rootDir, "app.db")),
    listRoots(repoTmp, "e2e-data.", (rootDir) => join(rootDir, "superscriber.db")),
  ];
  const candidates = scans
    .flatMap((scan) => scan.roots)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  const latest = candidates[0];
  if (!latest) {
    const errors = scans.flatMap((scan) => scan.errors);
    const detail = errors.length > 0 ? ` Candidate databases could not be read: ${errors.join("; ")}` : "";
    throw new Error(`No fresh Superscriber runtime root was found.${detail}`);
  }

  return latest;
}

export function withRuntimeDb<T>(run: (db: Database.Database) => T) {
  const runtime = resolveRuntimeRoot();
  const db = new Database(runtime.dbPath, { readonly: false });

  try {
    return run(db);
  } finally {
    db.close();
  }
}

// Host-side writes to the container's bind-mounted live database are unreliable
// in both supported environments: on Linux CI the files stay owned by the
// in-image user so the runner uid cannot write them, and on macOS the VM file
// sharing cannot propagate host WAL commits to the app's held connection.
// When the container e2e runner is active (it exports
// SUPERSCRIBER_E2E_CONTAINER_NAME) the write helpers therefore run inside the
// container, on the app's own kernel and user. Reads stay host-side.
const CONTAINER_DB_PATH =
  process.env.SUPERSCRIBER_E2E_CONTAINER_DB_PATH?.trim() || "/app/data/superscriber.db";

function e2eContainerName() {
  return process.env.SUPERSCRIBER_E2E_CONTAINER_NAME?.trim() || "";
}

function execContainerPython(script: string, args: string[]) {
  return execFileSync(
    "docker",
    ["exec", "--user", "node", e2eContainerName(), "python3", "-c", script, ...args],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
}

const CONTAINER_QUERY_SCRIPT = `import json, sqlite3, sys
db_path, sql = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
rows = [dict(row) for row in conn.execute(sql, sys.argv[3:])]
conn.close()
print(json.dumps(rows))
`;

function queryContainerDb<Row>(sql: string, params: string[]): Row[] {
  const output = execContainerPython(CONTAINER_QUERY_SCRIPT, [CONTAINER_DB_PATH, sql, ...params]);
  return JSON.parse(output) as Row[];
}

// The container harness runs the internal Python worker with a 1s poll and the
// stub transcript fallback, so a freshly uploaded recording leaves its
// processing window (queued/running state, which the admin dialog reports as
// "Waiting") within a couple of seconds. Assertions that must observe that
// window race the worker; pausing it with SIGSTOP freezes transcript progress
// without touching any app-visible state, and SIGCONT resumes it. No-op outside
// the container harness, where no worker is started on the suite's behalf.
const WORKER_SIGNAL_SCRIPT = `import os, signal, sys
action = sys.argv[1]
target = signal.SIGSTOP if action == "STOP" else signal.SIGCONT
self_pid = os.getpid()
matched = []
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    if pid == self_pid:
        continue
    try:
        with open("/proc/%s/cmdline" % pid, "rb") as fh:
            argv = [part for part in fh.read().split(bytes([0])) if part]
    except OSError:
        continue
    if argv and argv[-1].decode("utf-8", "ignore").endswith("worker/main.py"):
        os.kill(pid, target)
        matched.append(pid)
if action == "STOP" and not matched:
    raise SystemExit("internal worker process not found; cannot pause it")
print("worker", action, "pids:", matched)
`;

function signalInternalWorker(action: "STOP" | "CONT") {
  if (!e2eContainerName()) {
    return;
  }

  execContainerPython(WORKER_SIGNAL_SCRIPT, [action]);
}

export function pauseInternalWorker() {
  signalInternalWorker("STOP");
}

export function resumeInternalWorker() {
  signalInternalWorker("CONT");
}

export function expireUploadSession(sessionId: string) {
  const staleIso = new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString();
  const verificationSummary =
    "Temporary upload expired and was cleaned up. Start a new upload session to continue.";

  if (e2eContainerName()) {
    execContainerPython(
      `import os, sqlite3, sys
db_path, session_id, stale_iso, summary = sys.argv[1:5]
conn = sqlite3.connect(db_path)
conn.execute(
    "update ingestion_sessions set state = ?, updated_at = ?, verification_summary = ? where id = ?",
    ("interrupted", stale_iso, summary, session_id),
)
conn.commit()
conn.close()
upload = os.path.join(os.path.dirname(db_path), "uploads", session_id + ".upload")
if os.path.exists(upload):
    os.unlink(upload)
`,
      [CONTAINER_DB_PATH, sessionId, staleIso, verificationSummary],
    );
    return;
  }

  const runtime = resolveRuntimeRoot();
  const uploadPath = join(runtime.uploadDir, `${sessionId}.upload`);

  withRuntimeDb((db) => {
    db.prepare(
      `update ingestion_sessions set state = ?, updated_at = ?, verification_summary = ? where id = ?`,
    ).run("interrupted", staleIso, verificationSummary, sessionId);
  });

  unlinkSync(uploadPath);
}

export function expireActionMode(actionModeId: string) {
  const staleIso = new Date(Date.now() - 60_000).toISOString();

  if (e2eContainerName()) {
    execContainerPython(
      `import sqlite3, sys
db_path, action_mode_id, stale_iso = sys.argv[1:4]
conn = sqlite3.connect(db_path)
conn.execute("update admin_action_sessions set expires_at = ? where id = ?", (stale_iso, action_mode_id))
conn.commit()
conn.close()
`,
      [CONTAINER_DB_PATH, actionModeId, staleIso],
    );
    return;
  }

  withRuntimeDb((db) => {
    db.prepare(`update admin_action_sessions set expires_at = ? where id = ?`).run(
      staleIso,
      actionModeId,
    );
  });
}

// demo-model-tier-picker: fabricate provisioned model artifacts on whichever
// runtime hosts the catalog check, so a tier flips from unavailable to
// selectable without a server restart (the catalog stat()s on every request).
export function provisionRuntimeModelTier(tierId: string) {
  if (e2eContainerName()) {
    execContainerPython(
      `import os, sys
tier = sys.argv[1]
root = os.environ.get("SUPERSCRIBER_TRANSCRIBE_MODEL_DIR", "/app/models")
dir_path = os.path.join(root, tier)
os.makedirs(dir_path, exist_ok=True)
with open(os.path.join(dir_path, "model.bin"), "wb") as handle:
    handle.write(b"bin")
with open(os.path.join(dir_path, "config.json"), "w", encoding="utf8") as handle:
    handle.write("{}")
`,
      [tierId],
    );
    return;
  }

  const base = join(hostRuntimeModelRoot(), tierId);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "model.bin"), "bin");
  writeFileSync(join(base, "config.json"), "{}");
}

function hostRuntimeModelRoot() {
  const e2eRoot = process.env.SUPERSCRIBER_E2E_MODEL_DIR?.trim();
  const serverRoot = process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR?.trim();
  if (!e2eRoot || !serverRoot || resolve(e2eRoot) !== resolve(serverRoot)) {
    throw new Error(
      "Host E2E requires matching SUPERSCRIBER_E2E_MODEL_DIR and SUPERSCRIBER_TRANSCRIBE_MODEL_DIR values.",
    );
  }

  const root = resolve(e2eRoot);
  const safeParent = resolve(process.cwd(), ".tmp");
  const relativeRoot = relative(safeParent, root);
  if (
    !relativeRoot ||
    relativeRoot.startsWith("..") ||
    isAbsolute(relativeRoot) ||
    !basename(root).startsWith("e2e-models.")
  ) {
    throw new Error("Host E2E model directories must use .tmp/e2e-models.<run-id>.");
  }
  return root;
}

export function resetRuntimeModelTiers() {
  if (!e2eContainerName()) {
    rmSync(hostRuntimeModelRoot(), { recursive: true, force: true });
  }
}

export function cleanupRuntimeModelTiers() {
  resetRuntimeModelTiers();
}

export function queryRuntimeRows<Row>(sql: string, params: string[]): Row[] {
  if (e2eContainerName()) {
    return queryContainerDb<Row>(sql, params);
  }
  return withRuntimeDb((db) => db.prepare(sql).all(...params) as Row[]);
}

/**
 * Executes a write statement against the runtime database in whichever mode
 * the suite is running (host file or in-container interpreter).
 */
export function execRuntimeSql(sql: string, params: string[]) {
  if (e2eContainerName()) {
    execContainerPython(
      `import sqlite3, sys
db_path, sql = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.execute(sql, sys.argv[3:])
conn.commit()
conn.close()
`,
      [CONTAINER_DB_PATH, sql, ...params],
    );
    return;
  }

  withRuntimeDb((db) => {
    db.prepare(sql).run(...params);
  });
}

export function revokeAuthSessionsForEmail(email: string) {
  const revokedAt = new Date().toISOString();
  const sql = `update auth_sessions set status = 'revoked', revoked_at = ?, revoked_reason = 'e2e_revocation' where status = 'active' and user_id = (select id from users where email = ?)`;

  if (e2eContainerName()) {
    execContainerPython(
      `import sqlite3, sys
db_path, revoked_at, email = sys.argv[1:4]
conn = sqlite3.connect(db_path)
conn.execute(
    "update auth_sessions set status = 'revoked', revoked_at = ?, revoked_reason = 'e2e_revocation' where status = 'active' and user_id = (select id from users where email = ?)",
    (revoked_at, email),
)
conn.commit()
conn.close()
`,
      [CONTAINER_DB_PATH, revokedAt, email],
    );
    return;
  }

  withRuntimeDb((db) => {
    db.prepare(sql).run(revokedAt, email);
  });
}

export function accountRoleFactsForEmail(email: string) {
  return queryRuntimeRows<{
    id: string;
    role: string;
    isActive: number;
    authVersion: number;
  }>(
    `select id, role, is_active as isActive, auth_version as authVersion
     from users where email = ?`,
    [email],
  )[0];
}

export function accountRoleAuditRows(userId: string) {
  return queryRuntimeRows<{
    actorUserId: string | null;
    actorRole: string;
    createdAt: string;
    metadata: string;
  }>(
    `select actor_user_id as actorUserId, actor_role as actorRole,
            created_at as createdAt, metadata
     from audit_events
     where type = 'account.role_changed'
       and json_extract(metadata, '$.data.targetUserId') = ?
     order by created_at`,
    [userId],
  );
}

export function authSessionRowsForEmail(email: string) {
  const sql = `select auth_sessions.id, auth_sessions.status, auth_sessions.auth_source as authSource, auth_sessions.revoked_reason as revokedReason from auth_sessions join users on users.id = auth_sessions.user_id where users.email = ? order by auth_sessions.created_at`;
  if (e2eContainerName()) {
    return queryContainerDb<{
      id: string;
      status: string;
      authSource: string;
      revokedReason: string | null;
    }>(sql, [email]);
  }
  return withRuntimeDb(
    (db) =>
      db.prepare(sql).all(email) as Array<{
        id: string;
        status: string;
        authSource: string;
        revokedReason: string | null;
      }>,
  );
}

export function auditRows(recordingId: string) {
  const sql = `select type, detail, effective_role as effectiveRole, admin_action_session_id as adminActionSessionId, created_at as createdAt from audit_events where recording_id = ? order by created_at desc`;
  if (e2eContainerName()) {
    return queryContainerDb<{
      type: string;
      detail: string;
      effectiveRole: string | null;
      adminActionSessionId: string | null;
      createdAt: string;
    }>(sql, [recordingId]);
  }
  return withRuntimeDb(
    (db) =>
      db.prepare(sql).all(recordingId) as Array<{
        type: string;
        detail: string;
        effectiveRole: string | null;
        adminActionSessionId: string | null;
        createdAt: string;
      }>,
  );
}

export function assignmentRows(recordingId: string) {
  const sql = `select id, user_id as userId, assignment_role as assignmentRole, status, completed_revision_id as completedRevisionId from recording_assignments where recording_id = ? order by created_at desc`;
  if (e2eContainerName()) {
    return queryContainerDb<{
      id: string;
      userId: string;
      assignmentRole: string;
      status: string;
      completedRevisionId: string | null;
    }>(sql, [recordingId]);
  }
  return withRuntimeDb(
    (db) =>
      db.prepare(sql).all(recordingId) as Array<{
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

  // Wait-based checks: the accounts table is server-rendered and can stream
  // in after the load event, so a no-wait isVisible() here races hydration.
  const cell = page.getByRole("cell", { name: user.email }).first();
  const visible = await cell
    .waitFor({ state: "visible", timeout: 7_500 })
    .then(() => true)
    .catch(() => false);
  if (visible) {
    return true;
  }

  const search = page.getByLabel("Search accounts");
  await search.fill(user.email);
  await expect(cell).toBeVisible({ timeout: 7_500 }).catch(() => undefined);
  return cell.isVisible().catch(() => false);
}

export async function ensureLocalAccount(page: Page, user: LocalUser) {
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
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("cell", { name: user.email })).toBeVisible();
      return;
    }

    const error = await failureAlert
      .first()
      .textContent({ timeout: 10_000 })
      .catch(() => null);
    throw new Error(
      `Failed to create local account ${user.email}: ${error ?? "dialog closed without an alert"}`,
    );
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
      callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3105"}/workspace`,
      json: "true",
    },
  });
  expect(signInResponse.status()).toBeLessThan(400);

  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}

export async function logout(page: Page) {
  // Leave the guarded shell before clearing cookies so the session-state
  // poller cannot race this synthetic sign-out. (The real Sign out button
  // marks the tab instead; see signed-out-marker.ts.)
  await page.goto("/api/auth/session-state");
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

export async function uploadFixture(page: Page, input: { title: string; durationMs?: number }): Promise<string> {
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
    buffer: buildSilentWavBuffer(input.durationMs ? { durationMs: input.durationMs } : undefined),
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
    await ensureLocalAccount(page, user);
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
  // Casefile UX batch: the governance trigger lives in the casefile header
  // ("Governance >"); the drawer renders only while open.
  const openButton = page.getByRole("button", { name: /^Governance/ });
  if ((await openButton.count()) > 0 && (await openButton.isVisible().catch(() => false))) {
    if ((await openButton.getAttribute("aria-expanded")) !== "true") {
      await openButton.click();
    }
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
