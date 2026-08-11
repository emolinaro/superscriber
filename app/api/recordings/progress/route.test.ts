import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { getAppDbBundle, resetAppDatabaseForTests } from "@/server/db/client";
import { recordings, transcriptJobs, workspaces } from "@/server/db/schema";

const { getActivePrincipalMock } = vi.hoisted(() => ({
  getActivePrincipalMock: vi.fn(),
}));

vi.mock("@/server/session", () => ({
  getActivePrincipal: getActivePrincipalMock,
}));

import { GET } from "./route";

function insertRecordingWithJob(input: {
  recordingId: string;
  jobId: string;
  percent: number;
  until: number;
  duration: number;
  segments: number;
}) {
  const bundle = getAppDbBundle();

  bundle.db
    .insert(recordings)
    .values({
      id: input.recordingId,
      workspaceId: "workspace-1",
      title: input.recordingId,
      source: "upload",
      mediaKind: "audio",
      mimeType: "audio/wav",
      mediaPath: "/tmp/a.wav",
      originalFileName: "a.wav",
      languageHint: "en",
      uploadedByRole: "uploader",
      uploadedByUserId: null,
      ingestionSessionId: null,
      transcriptJobId: input.jobId,
      integrityState: "verified",
      transcriptJobState: "running",
      currentRevisionId: null,
      approvedRevisionId: null,
      pendingRevisionId: null,
      verificationSummary: null,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
      automationCursor: null,
    })
    .run();

  bundle.db
    .insert(transcriptJobs)
    .values({
      id: input.jobId,
      recordingId: input.recordingId,
      state: "running",
      adapter: "internal-python-worker",
      claimedByWorkerId: "worker-a",
      attemptCount: 1,
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:01.000Z",
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: null,
      lastHeartbeatAt: "2026-08-01T12:00:01.000Z",
      etaSeconds: 18,
      progressPercent: input.percent,
      transcribedUntilMs: input.until,
      audioDurationMs: input.duration,
      segmentsSeen: input.segments,
      outputRevisionId: null,
      lastError: null,
      diarizationStatus: "pending",
    })
    .run();
}

async function createPrincipal(input: {
  displayName: string;
  email: string;
  role: "admin" | "reviewer" | "approver" | "uploader";
}) {
  return toPrincipal(
    await createLocalUser(
      {
        ...input,
        password: "correct horse battery staple",
      },
      getAppDbBundle().db,
    ),
  );
}

describe("GET /api/recordings/progress", () => {
  let tempRoot = "";
  const originalDatabasePath = process.env.SUPERSCRIBER_DB_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAppDatabaseForTests();
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-progress-route-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "state.db");

    getAppDbBundle()
      .db.insert(workspaces)
      .values({
        id: "workspace-1",
        name: "Test workspace",
        slug: "test-workspace",
        policyProfileId: "strict",
      })
      .run();
  });

  afterEach(() => {
    resetAppDatabaseForTests();
    rmSync(tempRoot, { recursive: true, force: true });
    process.env.SUPERSCRIBER_DB_PATH = originalDatabasePath;
  });

  it("returns 401 for anonymous callers", async () => {
    getActivePrincipalMock.mockResolvedValue(null);

    const response = await GET(new Request("https://example.test/api/recordings/progress"));

    expect(response.status).toBe(401);
  });

  it("returns the engine samples of the latest job per authorized recording", async () => {
    insertRecordingWithJob({
      recordingId: "rec-live",
      jobId: "job-live",
      percent: 50,
      until: 30_000,
      duration: 60_000,
      segments: 7,
    });
    insertRecordingWithJob({
      recordingId: "rec-second",
      jobId: "job-second",
      percent: 99,
      until: 60_000,
      duration: 60_000,
      segments: 11,
    });

    getActivePrincipalMock.mockResolvedValue(
      await createPrincipal({
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      }),
    );

    const response = await GET(
      new Request(
        "https://example.test/api/recordings/progress?ids=rec-live,rec-second,rec-unknown",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(body.jobs).toEqual([
      {
        recordingId: "rec-live",
        state: "running",
        progressPercent: 50,
        transcribedUntilMs: 30_000,
        audioDurationMs: 60_000,
        segmentsSeen: 7,
        updatedAt: "2026-08-01T12:00:01.000Z",
      },
      {
        recordingId: "rec-second",
        state: "running",
        progressPercent: 99,
        transcribedUntilMs: 60_000,
        audioDurationMs: 60_000,
        segmentsSeen: 11,
        updatedAt: "2026-08-01T12:00:01.000Z",
      },
    ]);
  });

  it("hides recordings the caller has no casefile grant for", async () => {
    insertRecordingWithJob({
      recordingId: "rec-live",
      jobId: "job-live",
      percent: 50,
      until: 30_000,
      duration: 60_000,
      segments: 7,
    });

    // A reviewer with no assignment and no ownership sees nothing.
    getActivePrincipalMock.mockResolvedValue(
      await createPrincipal({
        displayName: "Outsider",
        email: "outsider@example.com",
        role: "reviewer",
      }),
    );

    const response = await GET(
      new Request("https://example.test/api/recordings/progress?ids=rec-live"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: unknown[] };
    expect(body.jobs).toEqual([]);
  });

  it("returns an empty payload when no ids are requested", async () => {
    getActivePrincipalMock.mockResolvedValue(
      await createPrincipal({
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      }),
    );

    const response = await GET(new Request("https://example.test/api/recordings/progress"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobs: [] });
  });
});
