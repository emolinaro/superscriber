import { buildMockTranscript } from "@/domain/mock-transcript";
import {
  IngestionSession,
  Recording,
  TranscriptJob,
  TranscriptSegment,
} from "@/domain/models";

export type VerificationStep = {
  nextState: IngestionSession["state"];
  summary: string;
  lastError: string | null;
};

export type TranscriptStep = {
  nextState: TranscriptJob["state"];
  progressPercent: number;
  etaSeconds: number | null;
  diarizationStatus: TranscriptJob["diarizationStatus"];
  summary: string;
  lastError: string | null;
  outputSegments?: TranscriptSegment[];
};

export type CanonicalOrchestrationAdapter = {
  id: string;
  stepVerification(params: {
    recording: Recording;
    session: IngestionSession;
    nowMs: number;
  }): VerificationStep | null;
  stepTranscriptJob(params: {
    recording: Recording;
    session: IngestionSession;
    job: TranscriptJob;
    nowMs: number;
  }): TranscriptStep | null;
};

function ageMs(timestamp: string | null, nowMs: number) {
  if (!timestamp) {
    return 0;
  }

  return Math.max(0, nowMs - Date.parse(timestamp));
}

function shouldFailVerification(recording: Recording) {
  const haystacks = [recording.title, recording.originalFileName, recording.mimeType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystacks.includes("corrupt") || haystacks.includes("broken");
}

export const mockGovernedEngine: CanonicalOrchestrationAdapter = {
  id: "mock-governed-engine",

  stepVerification({ recording, session, nowMs }) {
    if (session.state !== "verifying") {
      return null;
    }

    if (shouldFailVerification(recording)) {
      return {
        nextState: "verification_failed",
        summary: "Verification failed. The recording looks corrupt or unsupported.",
        lastError: "Mock verification rejected this media payload.",
      };
    }

    const elapsed = ageMs(session.startedAt ?? session.createdAt, nowMs);
    if (elapsed < 1_500) {
      return {
        nextState: "verifying",
        summary:
          "Governed verification is still running. No local copies are being persisted.",
        lastError: null,
      };
    }

    return {
      nextState: "verified",
      summary:
        "Recording verified server-side. Raw media remains inside the managed environment.",
      lastError: null,
    };
  },

  stepTranscriptJob({ recording, session, job, nowMs }) {
    if (session.state !== "verified") {
      return null;
    }

    const supportsPartial =
      recording.languageHint === "mixed" || recording.mediaKind === "video";

    if (job.state === "queued") {
      return {
        nextState: "running",
        progressPercent: 12,
        etaSeconds: 90,
        diarizationStatus: "pending",
        summary:
          "Transcript job accepted by the canonical orchestration layer. Diarization requested.",
        lastError: null,
      };
    }

    if (job.state === "running") {
      const elapsed = ageMs(job.startedAt ?? job.updatedAt ?? job.createdAt, nowMs);

      if (supportsPartial && elapsed >= 1_500) {
        return {
          nextState: "partial_result",
          progressPercent: 68,
          etaSeconds: 24,
          diarizationStatus: "degraded",
          summary:
            "Partial transcript is ready. Final diarization alignment is still being reconciled.",
          lastError: null,
        };
      }

      if (elapsed >= 2_500) {
        return {
          nextState: "completed",
          progressPercent: 100,
          etaSeconds: 0,
          diarizationStatus: "available",
          summary: "Transcript and diarization are ready for browser review.",
          lastError: null,
          outputSegments: buildMockTranscript(recording),
        };
      }

      return {
        nextState: "running",
        progressPercent: 45,
        etaSeconds: 46,
        diarizationStatus: "pending",
        summary: "Audio is being transcribed on the sovereign speech engine.",
        lastError: null,
      };
    }

    if (job.state === "partial_result") {
      const elapsed = ageMs(job.startedAt ?? job.updatedAt ?? job.createdAt, nowMs);
      if (elapsed >= 3_000) {
        return {
          nextState: "completed",
          progressPercent: 100,
          etaSeconds: 0,
          diarizationStatus: supportsPartial ? "degraded" : "available",
          summary: "Transcript finalized after partial-result reconciliation.",
          lastError: null,
          outputSegments: buildMockTranscript(recording),
        };
      }

      return {
        nextState: "partial_result",
        progressPercent: 76,
        etaSeconds: 18,
        diarizationStatus: "degraded",
        summary: "Partial transcript remains available while diarization continues.",
        lastError: null,
      };
    }

    return null;
  },
};
