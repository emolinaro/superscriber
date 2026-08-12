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
  job.progressPercent = null;
  job.etaSeconds = 90;

  return { recording, session, job };
}

describe("internal transcript queue", () => {
  it("derives the progress percent from real engine samples and keeps the liveness fields", () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const state = createBaseState();
      const { job } = queueVerifiedRecording(state, "Engine progress probe");
      writeState(state, bundle.db);

      claimAvailableTranscriptJob({ workerId: "worker-a", bundle });

      // A claim starts sample-free: a beat without engine data keeps the bar
      // in the liveness-pulse state.
      const warming = heartbeatTranscriptJob({ jobId: job.id, workerId: "worker-a", bundle });
      expect(warming.progressPercent).toBeNull();
      expect(warming.segmentsSeen).toBeNull();

      const base = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        progressPercent: 15,
        bundle,
      });
      expect(base.progressPercent).toBeNull();

      const first = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        transcribedUntilMs: 5000,
        audioDurationMs: 60000,
        segmentsSeen: 1,
        bundle,
      });
      expect(first.progressPercent).toBe(8);
      expect(first.segmentsSeen).toBe(1);

      const second = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        transcribedUntilMs: 30000,
        audioDurationMs: 60000,
        segmentsSeen: 7,
        progressPercent: 15, // stale staged value loses to engine data
        bundle,
      });
      expect(second.progressPercent).toBe(50);

      // Clamp: never report 100 before /complete lands.
      const late = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        transcribedUntilMs: 60000,
        audioDurationMs: 60000,
        segmentsSeen: 11,
        bundle,
      });
      expect(late.progressPercent).toBe(99);

      // Engine-free beats (no ms fields) keep the last real percent - a
      // heartbeat without new samples must not lurch the bar backwards.
      const quiet = heartbeatTranscriptJob({ jobId: job.id, workerId: "worker-a", bundle });
      expect(quiet.progressPercent).toBe(99);
      expect(quiet.segmentsSeen).toBe(11);
    } finally {
      bundle.sqlite.close();
    }
  });

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
      // demo-advanced-model-picker: no picker choice means the worker runs
      // its configured default (null), not an invented string.
      expect(claim?.transcriptModel).toBeNull();

      const heartbeat = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        state: "partial_result",
        progressPercent: 12,
        transcribedUntilMs: 43_200,
        audioDurationMs: 60_000,
        segmentsSeen: 8,
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
            speakerLabel: "  Speaker 1  ",
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
        persisted.revisions.find((revision) => revision.id === completion.outputRevisionId)
          ?.segments[0]?.speakerLabel,
      ).toBe("Speaker 1");
      expect(
        persisted.auditEvents.some((event) => event.type === "transcription.completed"),
      ).toBe(true);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("carries the recording's chosen transcription model into the worker claim", () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const state = createBaseState();
      const { recording } = queueVerifiedRecording(state, "Model-picked recording");
      recording.transcriptModel = "tiny";
      writeState(state, bundle.db);

      const claim = claimAvailableTranscriptJob({
        workerId: "worker-a",
        bundle,
      });
      expect(claim?.transcriptModel).toBe("tiny");
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
      job.progressPercent = 62;
      job.transcribedUntilMs = 37_200;
      job.audioDurationMs = 60_000;
      job.segmentsSeen = 9;
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
      // Stale reclaim clears the dead attempt's engine samples so the new
      // attempt's first beat cannot re-derive the old percent.
      expect(refreshedJob?.progressPercent).toBeNull();
      expect(refreshedJob?.transcribedUntilMs).toBeNull();
      expect(refreshedJob?.audioDurationMs).toBeNull();
      expect(refreshedJob?.segmentsSeen).toBeNull();

      const firstBeat = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-new",
        bundle,
      });
      expect(firstBeat.progressPercent).toBeNull();
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

  it("clears the failed attempt's engine samples when requeueing for retry", () => {
    const bundle = openAppDatabase(":memory:");

    try {
      const state = createBaseState();
      const { job } = queueVerifiedRecording(state, "Retry clears samples recording");
      writeState(state, bundle.db);

      claimAvailableTranscriptJob({ workerId: "worker-a", bundle });
      const running = heartbeatTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        transcribedUntilMs: 30_000,
        audioDurationMs: 60_000,
        segmentsSeen: 7,
        bundle,
      });
      expect(running.progressPercent).toBe(50);

      const requeued = failTranscriptJob({
        jobId: job.id,
        workerId: "worker-a",
        detail: "Engine crashed mid-run.",
        retryable: true,
        bundle,
      });
      expect(requeued.state).toBe("queued");
      expect(requeued.progressPercent).toBeNull();
      expect(requeued.transcribedUntilMs).toBeNull();
      expect(requeued.audioDurationMs).toBeNull();
      expect(requeued.segmentsSeen).toBeNull();

      const reclaim = claimAvailableTranscriptJob({ workerId: "worker-b", bundle });
      expect(reclaim?.jobId).toBe(job.id);

      const firstBeat = heartbeatTranscriptJob({ jobId: job.id, workerId: "worker-b", bundle });
      expect(firstBeat.progressPercent).toBeNull();
      expect(firstBeat.segmentsSeen).toBeNull();
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
