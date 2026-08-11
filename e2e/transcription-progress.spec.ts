import { expect, test, type Page } from "@playwright/test";
import {
  adminUser,
  bootstrapAndLogin,
  claimSimulatedTranscriptJob,
  completeSimulatedTranscriptJob,
  postSimulatedHeartbeat,
  pauseInternalWorker,
  resumeInternalWorker,
  uploadFixture,
} from "./support/appliance";

// Live transcription progress proof: a simulated engine drives the exact
// heartbeat contract the Python worker uses (transcribedUntilMs /
// audioDurationMs / segmentsSeen) and the UI percent must advance live - on
// the casefile status page and on the work ledger - in both appearance
// modes. The container lane's real worker is paused so the simulation owns
// the job; the host lane has the same shape with no worker contending once
// the job is claimed.

const DURATION_MS = 60_000;

async function expectAppearance(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function exerciseLiveProgress(page: Page, title: string) {
  pauseInternalWorker();
  let job: { jobId: string; recordingId: string } | null = null;
  try {
    await bootstrapAndLogin(page, adminUser);
    await uploadFixture(page, { title });

    // The status-only casefile surfaces the live bar immediately (warming cue
    // or 0%).
    const bar = page.getByRole("progressbar", { name: "Transcription progress" });
    await expect(bar).toBeVisible();

    // Claim can retry: integrity verification finishes asynchronously.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        job = await claimSimulatedTranscriptJob();
        break;
      } catch {
        await page.waitForTimeout(500);
      }
    }
    if (!job) {
      throw new Error("simulated worker never found a queued job to claim");
    }

    await postSimulatedHeartbeat(job.jobId, {
      transcribedUntilMs: 12_000,
      audioDurationMs: DURATION_MS,
      segmentsSeen: 2,
    });
    await expect(bar).toHaveAttribute("aria-valuenow", "20", { timeout: 20_000 });
    await expect(page.getByText(/Segment 2/)).toBeVisible();
    await expect(page.getByText(/0:12 of 1:00/)).toBeVisible();

    // The percent advances while the job is still running - the "live" half
    // of the bring-back.
    await postSimulatedHeartbeat(job.jobId, {
      transcribedUntilMs: 36_000,
      audioDurationMs: DURATION_MS,
      segmentsSeen: 5,
    });
    await expect(bar).toHaveAttribute("aria-valuenow", "60", { timeout: 20_000 });
    await expect(page.getByText(/Segment 5/)).toBeVisible();

    // Same live sample on the work ledger (list lane polls the batch route).
    await page.goto("/workspace");
    const ledgerRow = page
      .locator(".recording-table tbody tr, .recording-card")
      .filter({ hasText: title });
    await expect(
      ledgerRow.getByRole("progressbar", { name: "Transcription progress" }),
    ).toHaveAttribute("aria-valuenow", "60", { timeout: 20_000 });

    await completeSimulatedTranscriptJob(job.jobId);

    // Completion retires the in-flight surface on both lanes.
    await page.goto(`/recordings/${job.recordingId}`);
    await expect(
      page.getByRole("progressbar", { name: "Transcription progress" }),
    ).toHaveCount(0, { timeout: 30_000 });
  } finally {
    if (job) {
      await completeSimulatedTranscriptJob(job.jobId).catch(() => {});
    }
    resumeInternalWorker();
  }
}

test.describe.serial("live transcription progress", () => {
  test("advances the percent live during transcription in dark appearance", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("superscriber.theme", "dark");
    });
    await page.goto("/");
    await exerciseLiveProgress(page, "Live progress dark record");
    await expectAppearance(page, "dark");
  });

  test("advances the percent live during transcription in light appearance", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("superscriber.theme", "light");
    });
    await page.goto("/");
    await exerciseLiveProgress(page, "Live progress light record");
    await expectAppearance(page, "light");
  });
});
