import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppDbBundle, resetAppDatabaseForTests } from "@/server/db/client";
import { recordings, transcriptJobs, workspaces } from "@/server/db/schema";
import { resolveEngineSharedSecret } from "@/server/orchestration/secret";

import { POST } from "./route";

function insertFailedRunnerFixture() {
  const bundle = getAppDbBundle();
  bundle.db
    .insert(workspaces)
    .values({
      id: "workspace-1",
      name: "Test workspace",
      slug: "test-workspace",
      policyProfileId: "strict",
    })
    .run();
  bundle.db
    .insert(recordings)
    .values({
      id: "rec-fail",
      workspaceId: "workspace-1",
      title: "Fail target",
      source: "upload",
      mediaKind: "audio",
      mimeType: "audio/wav",
      mediaPath: "/tmp/a.wav",
      originalFileName: "a.wav",
      languageHint: "en",
      uploadedByRole: "uploader",
      uploadedByUserId: null,
      ingestionSessionId: null,
      transcriptJobId: "job-fail",
      integrityState: "verified",
      transcriptJobState: "running",
      currentRevisionId: null,
      approvedRevisionId: null,
      pendingRevisionId: null,
      verificationSummary: null,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:01.000Z",
      automationCursor: null,
    })
    .run();
  bundle.db
    .insert(transcriptJobs)
    .values({
      id: "job-fail",
      recordingId: "rec-fail",
      state: "running",
      adapter: "internal-python-worker",
      claimedByWorkerId: "worker-a",
      attemptCount: 1,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:01.000Z",
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: null,
      lastHeartbeatAt: new Date().toISOString(),
      etaSeconds: 18,
      progressPercent: 40,
      transcribedUntilMs: null,
      audioDurationMs: null,
      segmentsSeen: null,
      outputRevisionId: null,
      lastError: null,
      diarizationStatus: "pending",
    })
    .run();
}

function failRequest(payload: Record<string, unknown>) {
  return new Request("http://app.test/api/internal/transcript-jobs/job-fail/fail", {
    method: "POST",
    headers: (() => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const secret = resolveEngineSharedSecret();
      if (secret) {
        headers.authorization = `Bearer ${secret}`;
      }
      return headers;
    })(),
    body: JSON.stringify(payload),
  });
}

const routeContext = { params: Promise.resolve({ jobId: "job-fail" }) };

describe("POST /api/internal/transcript-jobs/[jobId]/fail", () => {
  let tempRoot = "";
  const originalDatabasePath = process.env.SUPERSCRIBER_DB_PATH;

  beforeEach(() => {
    resetAppDatabaseForTests();
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-fail-route-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "state.db");
    insertFailedRunnerFixture();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAppDatabaseForTests();
    rmSync(tempRoot, { recursive: true, force: true });
    process.env.SUPERSCRIBER_DB_PATH = originalDatabasePath;
  });

  it("persists a stable failure class and ops-only technical detail", async () => {
    const response = await POST(
      failRequest({
        workerId: "worker-a",
        detail:
          "Transcription failed - model/config mismatch. Delete this recording and upload it again; if it repeats, contact your operator with these words: mel-shape-mismatch.",
        retryable: false,
        errorClass: "mel-shape-mismatch",
        technicalDetail:
          "model=large-v3 n_mels_expected=128 n_mels_prepared=80 ValueError: Invalid input features shape ...",
      }),
      routeContext,
    );

    expect(response.status).toBe(200);
    const job = getAppDbBundle()
      .db.select()
      .from(transcriptJobs)
      .get();
    expect(job?.state).toBe("failed");
    expect(job?.lastError).toContain("contact your operator with these words");
    expect(job?.lastErrorKind).toBe("mel-shape-mismatch");
    expect(job?.lastErrorTechnical).toContain("n_mels_expected=128");
  });

  it("drops malformed error classes instead of persisting them", async () => {
    const response = await POST(
      failRequest({
        workerId: "worker-a",
        detail: "Legacy unclassified failure detail.",
        retryable: false,
        errorClass: "<script>alert(1)</script>",
        technicalDetail: "stack ".padEnd(6_000, "x"),
      }),
      routeContext,
    );

    expect(response.status).toBe(200);
    const job = getAppDbBundle().db.select().from(transcriptJobs).get();
    expect(job?.lastErrorKind).toBeNull();
    expect(job?.lastErrorTechnical).toHaveLength(4_000);
  });

  it("keeps legacy workers without classification fields working", async () => {
    const response = await POST(
      failRequest({ workerId: "worker-a", detail: "Backend timed out.", retryable: false }),
      routeContext,
    );

    expect(response.status).toBe(200);
    const job = getAppDbBundle().db.select().from(transcriptJobs).get();
    expect(job?.lastError).toBe("Backend timed out.");
    expect(job?.lastErrorKind).toBeNull();
    expect(job?.lastErrorTechnical).toBeNull();
  });
});
