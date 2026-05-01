import { describe, expect, it } from "vitest";
import { AppState, PolicyProfile, Workspace } from "@/domain/models";
import { createRecordingEntry } from "@/domain/workflow";
import { openAppDatabase } from "@/server/db/client";
import {
  claimAvailableTranscriptJob,
  completeTranscriptJob,
  failTranscriptJob,
  heartbeatTranscriptJob,
} from "@/server/orchestration/internal-queue";
import { readState, writeState } from "@/server/store";

function createBaseState(): AppState {
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Regulated",
    slug: "regulated",
    policyProfileId: "strict",
  };

  const policies: PolicyProfile[] = [
    {
      id: "strict",
      label: "Strict",
      description: "Strict regulated mode.",
    },
  ];

  return {
    workspaces: [workspace],
    policyProfiles: policies,
    recordings: [],
    ingestionSessions: [],
    transcriptJobs: [],
    revisions: [],
    approvals: [],
    auditEvents: [],
  };
}

function queueVerifiedRecording(state: AppState, title: string) {
  const recording = createRecordingEntry({
    state,
    workspaceId: state.workspaces[0].id,
    title,
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: `/tmp/${title.replace(/\s+/g, "-").toLowerCase()}.wav`,
    originalFileName: `${title}.wav`,
    languageHint: "english",
    role: "uploader",
    adapterId: "internal-python-worker",
  });

  const session = state.ingestionSessions.find((entry) => entry.id === recording.ingestionSessionId);
  const job = state.transcriptJobs.find((entry) => entry.id === recording.transcriptJobId);

  if (!session || !job) {
    throw new Error("Expected queueVerifiedRecording to create session and job.");
  }

  session.state = "verified";
  session.verifiedAt = session.updatedAt;
  session.verificationSummary = "Verified for internal worker testing.";
  recording.integrityState = "verified";
  recording.verificationSummary = session.verificationSummary;
  recording.transcriptJobState = "queued";
  job.state = "queued";
  job.progressPercent = 0;
  job.etaSeconds = 90;

  return { recording, session, job };
}

describe("internal transcript queue", () => {
  it("claims a queued verified job, accepts heartbeats, and completes with a first draft", () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const state = createBaseState();
      const { job, recording } = queueVerifiedRecording(state, "Queued recording");
      writeState(state, bundle.db);

      const claim = claimAvailableTranscriptJob({
        workerId: "worker-a",
        bundle,
      });
      expect(claim?.jobId).toBe(job.id);
      expect(claim?.recordingId).toBe(recording.id);
      expect(claim?.attemptCount).toBe(1);

      const heartbeat = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        state: "partial_result",
        progressPercent: 72,
        etaSeconds: 18,
        diarizationStatus: "degraded",
        bundle,
      });
      expect(heartbeat.state).toBe("partial_result");
      expect(heartbeat.progressPercent).toBe(72);

      const completion = completeTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        summary: "Transcript ready for review.",
        diarizationStatus: "degraded",
        segments: [
          {
            id: "seg-1",
            speakerLabel: "Speaker 1",
            startMs: 0,
            endMs: 1200,
            text: "Hello from the internal worker.",
            confidence: 0.92,
          },
        ],
        bundle,
      });
      expect(completion.state).toBe("completed");
      expect(completion.outputRevisionId).toBeTruthy();

      const persisted = readState(bundle.db);
      const persistedRecording = persisted.recordings.find((entry) => entry.id === recording.id);
      const persistedJob = persisted.transcriptJobs.find((entry) => entry.id === job.id);
      expect(persistedRecording?.currentRevisionId).toBeTruthy();
      expect(persistedJob?.claimedByWorkerId).toBeNull();
      expect(persistedJob?.state).toBe("completed");
      expect(
        persisted.auditEvents.some((event) => event.type === "transcription.completed"),
      ).toBe(true);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("reclaims a stale running job for a new worker", () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const state = createBaseState();
      const { job, recording } = queueVerifiedRecording(state, "Stale recording");
      const staleIso = new Date(Date.now() - 1000 * 60 * 10).toISOString();
      job.state = "running";
      job.claimedByWorkerId = "worker-old";
      job.attemptCount = 1;
      job.startedAt = staleIso;
      job.updatedAt = staleIso;
      job.lastHeartbeatAt = staleIso;
      recording.transcriptJobState = "running";
      recording.updatedAt = staleIso;
      writeState(state, bundle.db);

      const claim = claimAvailableTranscriptJob({
        workerId: "worker-new",
        staleAfterMs: 1000,
        bundle,
      });

      expect(claim?.jobId).toBe(job.id);
      expect(claim?.workerId).toBe("worker-new");
      expect(claim?.attemptCount).toBe(2);

      const refreshed = readState(bundle.db);
      const refreshedJob = refreshed.transcriptJobs.find((entry) => entry.id === job.id);
      expect(refreshedJob?.claimedByWorkerId).toBe("worker-new");
      expect(refreshedJob?.state).toBe("running");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("claims jobs inside an immediate sqlite transaction", () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const state = createBaseState();
      queueVerifiedRecording(state, "Immediate claim recording");
      writeState(state, bundle.db);

      const sqlite = bundle.sqlite as typeof bundle.sqlite & {
        transaction: typeof bundle.sqlite.transaction;
      };
      const originalTransaction = sqlite.transaction.bind(sqlite);
      let usedImmediate = false;

      sqlite.transaction = ((fn: Parameters<typeof originalTransaction>[0]) => {
        const transaction = originalTransaction(fn);
        const wrapped = ((...args: Parameters<typeof transaction>) =>
          transaction(...args)) as typeof transaction;

        Object.defineProperties(wrapped, {
          immediate: {
            value: ((...args: Parameters<typeof transaction.immediate>) => {
              usedImmediate = true;
              return transaction.immediate(...args);
            }) as typeof transaction.immediate,
          },
          deferred: {
            value: transaction.deferred.bind(transaction),
          },
          exclusive: {
            value: transaction.exclusive.bind(transaction),
          },
        });

        return wrapped;
      }) as typeof sqlite.transaction;

      const claim = claimAvailableTranscriptJob({
        workerId: "worker-immediate",
        bundle,
      });

      expect(claim).not.toBeNull();
      expect(usedImmediate).toBe(true);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("requeues retryable failures until the max attempt threshold is reached", () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const state = createBaseState();
      const { job } = queueVerifiedRecording(state, "Retry recording");
      writeState(state, bundle.db);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claim = claimAvailableTranscriptJob({
          workerId: "worker-retry",
          bundle,
        });
        expect(claim?.jobId).toBe(job.id);

        const snapshot = failTranscriptJob({
          jobId: job.id,
          workerId: "worker-retry",
          detail: `Attempt ${attempt} failed.`,
          retryable: true,
          bundle,
        });

        if (attempt < 3) {
          expect(snapshot.state).toBe("queued");
        } else {
          expect(snapshot.state).toBe("failed");
        }
      }

      const refreshed = readState(bundle.db);
      const refreshedJob = refreshed.transcriptJobs.find((entry) => entry.id === job.id);
      expect(refreshedJob?.state).toBe("failed");
      expect(refreshedJob?.attemptCount).toBe(3);
      expect(
        refreshed.auditEvents.filter((event) => event.type === "transcription.failed").length,
      ).toBe(3);
    } finally {
      bundle.sqlite.close();
    }
  });
});
