import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  adminUser,
  approverUser,
  bootstrapAndLogin,
  createAndAssignUsers,
  createSilentWavFixture,
  expireUploadSession,
  login,
  logout,
  outsiderUser,
  pauseInternalWorker,
  queryRuntimeRows,
  resumeInternalWorker,
  reviewerUser,
  setUploadFile,
  uploadFixture,
  uploaderUser,
} from "./support/appliance";

function fakeBrowserRecordingScript() {
  type FakeListener = (event?: Event & { data?: Blob }) => void;

  class FakeRecorder {
    state: "inactive" | "recording" | "paused" = "inactive";
    mimeType = "audio/webm";
    private listeners = new Map<string, Set<FakeListener>>();

    constructor() {
      const counter = window as unknown as { __fakeRecorderCreated?: number };
      counter.__fakeRecorderCreated = (counter.__fakeRecorderCreated ?? 0) + 1;
    }

    addEventListener(type: string, listener: FakeListener) {
      const current = this.listeners.get(type) ?? new Set<FakeListener>();
      current.add(listener);
      this.listeners.set(type, current);
    }

    removeEventListener(type: string, listener: FakeListener) {
      this.listeners.get(type)?.delete(listener);
    }

    start() {
      this.state = "recording";
    }

    pause() {
      if (this.state === "recording") {
        this.state = "paused";
      }
    }

    resume() {
      if (this.state === "paused") {
        this.state = "recording";
      }
    }

    stop() {
      if (this.state === "inactive") {
        return;
      }
      this.state = "inactive";
      const data = new Blob(["e2e-recorded-audio"], { type: "audio/webm" });
      this.listeners.get("dataavailable")?.forEach((listener) => {
        listener({ data } as Event & { data: Blob });
      });
      this.listeners.get("stop")?.forEach((listener) => {
        listener(new Event("stop"));
      });
    }
  }

  Object.defineProperty(window, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: FakeRecorder,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () =>
        Promise.resolve({
          getTracks: () => [
            {
              stop: () => {},
              addEventListener: () => {},
              removeEventListener: () => {},
            },
          ],
        }),
    },
  });
}

async function expectInteractiveTarget(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

async function expectNoHorizontalScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
}

test.describe.serial("mock appliance auth, ingest, and administration", () => {
  test("bootstraps local auth, safe return paths, and logout recovery", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /First-run setup|Sign in/ })).toBeVisible();
    if (await page.getByRole("heading", { name: "First-run setup" }).isVisible().catch(() => false)) {
      await expect(page.getByRole("heading", { name: "Readiness checks" })).toBeVisible();
      for (const check of [
        "Database",
        "Media storage",
        "Upload storage",
        "Auth secret",
        "Engine configuration",
      ]) {
        await expect(page.getByText(check, { exact: true })).toBeVisible();
      }

      await page.getByLabel("Administrator name").fill(adminUser.displayName);
      await page.getByLabel("Administrator email").fill(adminUser.email);
      await page.getByLabel(/^Password$/).fill(adminUser.password);
      await page.getByLabel("Confirm password").fill(adminUser.password);
      await page.getByRole("button", { name: "Create admin" }).click();

      await expect(page).toHaveURL(/notice=bootstrap-complete/);
      await expect(
        page.getByText(
          "First-run setup is complete. Sign in with the admin account you just created.",
        ),
      ).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    }

    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await page.getByLabel("Email").fill(adminUser.email);
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveValue("");
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);

    await login(page, adminUser);
    await page.goto("/?returnTo=%2Fadministration");
    await expect(page).toHaveURL(/\/administration$/);
    await expect(page.getByRole("navigation", { name: "Primary" })).toContainText(
      "Administration",
    );

    await logout(page);
    await expect(page.getByText("Your session ended safely.")).toBeVisible();

    await page.goto("/administration");
    await expect(page).toHaveURL(/reason=session-expired/);
    await expect(page).toHaveURL(/returnTo=%2Fadministration/);
    await expect(page.getByText("Session expired. Sign in again to continue.")).toBeVisible();

    await login(page, adminUser);
    await page.goto("/?returnTo=%2Fadministration");
    await expect(page).toHaveURL(/\/administration$/);
  });

  test("supports desktop and phone ingest, recovery, microphone denial, and dispatch warnings", async ({
    browser,
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);
    const recordingId = await uploadFixture(page, { title: "Governed appliance seed" });
    await createAndAssignUsers(page, recordingId);
    await expect(page.getByRole("heading", { name: "Governed appliance seed" })).toBeVisible();

    const phoneContext = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const phonePage = await phoneContext.newPage();
    await login(phonePage, adminUser);
    await phonePage.goto("/ingest");
    await phonePage.locator("#recording-title").fill("Phone upload recording");
    await phonePage.locator("#recording-language").selectOption("english");
    await setUploadFile(phonePage, {
      name: "phone-upload.wav",
      mimeType: "audio/wav",
      buffer: Buffer.from("RIFF....WAVE"),
    });
    await phonePage.getByRole("button", { name: "Upload file" }).click();
    await expect(phonePage).toHaveURL(/\/recordings\/[^/?]+/);
    await expect(phonePage.getByRole("heading", { name: "Phone upload recording" })).toBeVisible();
    await phoneContext.close();

    const interruptedFixture = createSilentWavFixture("resume-interrupted.wav", 90_000);
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
      await page.goto("/ingest");
      await page.locator("#recording-title").fill("Interrupted upload recording");
      await page.locator("#recording-language").selectOption("english");
      await setUploadFile(page, interruptedFixture.path);
      await page.getByRole("button", { name: "Upload file" }).click();
      await expect(
        page.locator("section.ingest-resume-card").getByText(/Choose the same file again to resume safely\./),
      ).toBeVisible();

      await page.reload();
      await expect(page.getByText(/Resume upload for resume-interrupted\.wav from 1048576 B committed\./)).toBeVisible();
      await page.locator("#recording-title").fill("Interrupted upload recording");
      await page.locator("#recording-language").selectOption("english");

      await page.unroute("**/api/ingest/sessions/*/chunk");
      await setUploadFile(page, interruptedFixture.path);
      await page.getByRole("button", { name: "Upload file" }).click();
      await expect(page).toHaveURL(/\/recordings\/[^/?]+/);
    } finally {
      interruptedFixture.cleanup();
    }

    const expiredFixture = createSilentWavFixture("resume-expired.wav", 90_000);
    chunkRequestCount = 0;
    await page.route("**/api/ingest/sessions/*/chunk", async (route) => {
      chunkRequestCount += 1;
      if (chunkRequestCount === 2) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    try {
      await page.goto("/ingest");
      await page.locator("#recording-title").fill("Expired upload recording");
      await page.locator("#recording-language").selectOption("english");
      await setUploadFile(page, expiredFixture.path);
      await page.getByRole("button", { name: "Upload file" }).click();
      await expect(
        page.locator("section.ingest-resume-card").getByText(/Choose the same file again to resume safely\./),
      ).toBeVisible();

      const pending = await page.evaluate(() =>
        JSON.parse(window.localStorage.getItem("superscriber.pendingIngest") ?? "null"),
      );
      expireUploadSession(pending.sessionId);
      await page.reload();
      await expect(
        page.locator("section.ingest-resume-card", {
          hasText:
            /Temporary upload expired and was cleaned up\. Start a new upload session to continue\.|Superscriber is checking the stored upload\./,
        }),
      ).toBeVisible();
      await page.locator("#recording-title").fill("Expired upload recording");
      await page.locator("#recording-language").selectOption("english");

      await page.unroute("**/api/ingest/sessions/*/chunk");
      await setUploadFile(page, expiredFixture.path);
      await page.getByRole("button", { name: "Upload file" }).click();
      await expect(page).toHaveURL(/\/recordings\/[^/?]+/);
    } finally {
      expiredFixture.cleanup();
    }

    const deniedContext = await browser.newContext();
    await deniedContext.addInitScript(() => {
      class FakeRecorder {
        mimeType = "audio/webm";
        state = "inactive";
        addEventListener() {}
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      }

      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        writable: true,
        value: FakeRecorder,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () => Promise.reject(new Error("Denied")),
        },
      });
    });
    const deniedPage = await deniedContext.newPage();
    await login(deniedPage, adminUser);
    await deniedPage.goto("/ingest");
    await deniedPage.getByLabel("Record audio").check();
    await deniedPage.getByRole("button", { name: "Start recording" }).click();
    await expect(
      deniedPage.getByText("Microphone access was blocked. Choose Upload file to continue safely."),
    ).toBeVisible();
    await deniedPage.getByLabel("Upload file").check();
    await expect(deniedPage.locator("#upload-file")).toBeVisible();
    await deniedContext.close();

    const uploaderPage = await browser.newPage();
    await login(uploaderPage, uploaderUser);
    await uploaderPage.route("**/api/ingest/sessions/*/finalize", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        ok: true;
        status: Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: {
          ...body,
          status: {
            ...body.status,
            warning: "Upload stored, but backend dispatch failed: Synthetic dispatch outage.",
          },
        },
      });
    });
    await uploaderPage.goto("/ingest");
    await uploaderPage.locator("#recording-title").fill("Uploader dispatch warning");
    await uploaderPage.locator("#recording-language").selectOption("english");
    await setUploadFile(uploaderPage, {
      name: "dispatch-warning.wav",
      mimeType: "audio/wav",
      buffer: Buffer.from("RIFF....WAVE"),
    });
    await uploaderPage.getByRole("button", { name: "Upload file" }).click();
    await expect(uploaderPage).toHaveURL(/\/workspace\?error=/);
    await expect(
      uploaderPage.getByText(
        "Upload stored, but backend dispatch failed: Synthetic dispatch outage.",
      ),
    ).toBeVisible();
    await uploaderPage.close();
  });

  test("keeps browser capture in-tab until an explicit upload handoff", async ({ browser }) => {
    const recordContext = await browser.newContext();
    await recordContext.addInitScript(fakeBrowserRecordingScript);
    const recordPage = await recordContext.newPage();

    const sessionCreates: string[] = [];
    recordPage.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/ingest/sessions") {
        sessionCreates.push(request.url());
      }
    });

    await login(recordPage, adminUser);
    await recordPage.goto("/ingest");
    await recordPage.locator("#recording-title").fill("In-tab recording lifecycle");
    await recordPage.locator("#recording-language").selectOption("english");
    await recordPage.getByLabel("Record audio").check();

    const startButton = recordPage.getByRole("button", { name: "Start recording" });
    const pauseButton = recordPage.getByRole("button", { name: "Pause recording" });
    const resumeButton = recordPage.getByRole("button", { name: "Resume recording" });
    const stopButton = recordPage.getByRole("button", { name: "Stop recording" });

    await startButton.focus();
    await expect(startButton).toBeFocused();
    await recordPage.keyboard.press("Enter");

    await expect(pauseButton).toBeEnabled();
    await expect(stopButton).toBeEnabled();
    await expect(startButton).toBeDisabled();
    await expect(recordPage.getByRole("status")).toContainText(/Recording in progress\./);

    await pauseButton.focus();
    await recordPage.keyboard.press("Enter");

    await expect(resumeButton).toBeEnabled();
    await expect(resumeButton).toBeFocused();
    await expect(stopButton).toBeEnabled();
    await expect(pauseButton).toHaveCount(0);
    await expect(recordPage.getByRole("status")).toContainText(/Recording paused\./);

    await recordPage.keyboard.press("Tab");
    await expect(stopButton).toBeFocused();

    await resumeButton.focus();
    await recordPage.keyboard.press("Enter");

    await expect(pauseButton).toBeEnabled();
    await expect(pauseButton).toBeFocused();
    await expect(recordPage.getByRole("status")).toContainText(/Recording in progress\./);

    await recordPage.keyboard.press("Tab");
    await expect(stopButton).toBeFocused();
    await recordPage.keyboard.press("Enter");

    await expect(recordPage.getByLabel("Recorded audio preview")).toBeVisible();
    await expect(recordPage.getByRole("button", { name: "Discard" })).toBeVisible();

    expect(sessionCreates).toHaveLength(0);
    await expect(
      recordPage.evaluate(() => window.localStorage.getItem("superscriber.pendingIngest")),
    ).resolves.toBeNull();

    const recorderCount = await recordPage.evaluate(
      () =>
        (window as unknown as { __fakeRecorderCreated?: number }).__fakeRecorderCreated ?? 0,
    );
    expect(recorderCount).toBe(1);

    await recordPage.getByRole("button", { name: "Upload recording" }).click();
    await expect(recordPage).toHaveURL(/\/recordings\/[^/?]+/, { timeout: 30_000 });
    await expect(
      recordPage.getByRole("heading", { name: "In-tab recording lifecycle" }),
    ).toBeVisible();
    expect(sessionCreates).toHaveLength(1);

    const recordingId = recordPage.url().match(/\/recordings\/([^/?]+)/)?.[1] ?? "";
    expect(recordingId).not.toBe("");
    const rows = queryRuntimeRows<{
      source: string;
      uploaded_by_role: string;
      uploaded_by_user_id: string | null;
    }>(
      "SELECT source, uploaded_by_role, uploaded_by_user_id FROM recordings WHERE id = ?",
      [recordingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("record");
    expect(rows[0]?.uploaded_by_role).toBe("admin");
    const adminRows = queryRuntimeRows<{ id: string }>("SELECT id FROM users WHERE email = ?", [
      adminUser.email,
    ]);
    expect(rows[0]?.uploaded_by_user_id).toBe(adminRows[0]?.id);

    await recordContext.close();
  });

  test("keeps capture controls at 44 px targets on 320 and 390 px widths", async ({ browser }) => {
    for (const width of [320, 390]) {
      const narrowContext = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width, height: 844 },
      });
      await narrowContext.addInitScript(fakeBrowserRecordingScript);
      const narrowPage = await narrowContext.newPage();
      await login(narrowPage, adminUser);
      await narrowPage.goto("/ingest");
      await narrowPage.locator("#recording-title").fill(`Narrow capture ${width}`);
      await narrowPage.locator("#recording-language").selectOption("english");
      await narrowPage.getByLabel("Record audio").check();

      await narrowPage.getByRole("button", { name: "Start recording" }).click();

      const pauseButton = narrowPage.getByRole("button", { name: "Pause recording" });
      const stopButton = narrowPage.getByRole("button", { name: "Stop recording" });
      await expect(pauseButton).toBeEnabled();
      await expect(stopButton).toBeEnabled();
      await expectInteractiveTarget(pauseButton);
      await expectInteractiveTarget(stopButton);
      await expectNoHorizontalScroll(narrowPage);

      await pauseButton.click();
      const resumeButton = narrowPage.getByRole("button", { name: "Resume recording" });
      await expect(resumeButton).toBeEnabled();
      await expectInteractiveTarget(resumeButton);
      await expectInteractiveTarget(stopButton);

      await stopButton.click();
      const discardButton = narrowPage.getByRole("button", { name: "Discard" });
      await expect(discardButton).toBeVisible();
      await expectInteractiveTarget(discardButton);
      await expectNoHorizontalScroll(narrowPage);

      await narrowContext.close();
    }
  });

  test("shows account, assignment, history, and policy administration surfaces", async ({ page }) => {
    await bootstrapAndLogin(page, adminUser);

    await page.goto("/administration?section=accounts");
    await expect(page.getByRole("heading", { name: "Institutional accounts" })).toBeVisible();
    await expect(page.getByRole("cell", { name: reviewerUser.email })).toBeVisible();
    await expect(page.getByRole("cell", { name: approverUser.email })).toBeVisible();
    await expect(page.getByRole("cell", { name: uploaderUser.email })).toBeVisible();

    // The internal worker would claim and finish this fixture's transcript job
    // within seconds, racing the dialog's "Current state: Waiting" assertion.
    // Hold it stopped until the dialog observation is done.
    pauseInternalWorker();
    let waitingRecordingId = "";
    try {
      waitingRecordingId = await uploadFixture(page, { title: "Waiting compatibility record" });
      await page.goto("/administration?section=assignments");
      await page.getByRole("button", { name: "Assign work" }).click();
      const assignDialog = page.getByRole("dialog", { name: "Assign governed work" });
      await expect(assignDialog).toBeVisible();
      await assignDialog.getByLabel("Recording search").fill("Waiting compatibility record");
      await assignDialog.getByLabel("Assigned user search").fill(reviewerUser.displayName);
      await expect(assignDialog.getByText("Current state: Waiting")).toBeVisible();
      await assignDialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      resumeInternalWorker();
    }

    await page.goto("/administration?section=assignments");
    await expect(page.getByRole("heading", { name: "Assignments" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove assignment" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Remove assignment" }).first().click();
    const removeDialog = page.getByRole("dialog", { name: "Remove assignment" });
    await expect(removeDialog).toBeVisible();
    await removeDialog.getByRole("button", { name: "Remove assignment" }).click();
    await expect(page.getByRole("status")).toContainText("Recording assignment removed.");

    await page.getByRole("link", { name: "History" }).click();
    await expect(page).toHaveURL(/status=history/);
    await expect(page.getByRole("cell", { name: "Removed" }).first()).toBeVisible();

    await login(page, outsiderUser);
    await page.goto(`/recordings/${waitingRecordingId}`);
    await expect(page).toHaveURL(/\/workspace\?error=/);
    await expect(page.getByText("This casefile is not available to your account.")).toBeVisible();

    await login(page, adminUser);
    await page.goto("/administration?section=policy");
    await expect(page.getByRole("heading", { name: "Policy" })).toBeVisible();
    await expect(page.getByText("Request changes").first()).toBeVisible();
    await expect(page.getByText("Phone safety").first()).toBeVisible();
    await expect(page.getByText("Server only").first()).toBeVisible();

  });
});
