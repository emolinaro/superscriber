import {
  AppState,
  AuditEvent,
  IngestionSession,
  Recording,
  TranscriptSegment,
  TranscriptJob,
} from "@/domain/models";
import { createSystemDraftRevision } from "@/domain/workflow";
import { EMPTY_AUDIT_METADATA } from "@/server/db/mappers";
import {
  CanonicalOrchestrationAdapter,
} from "@/server/orchestration/mock-engine";
import { resolveAdapter } from "@/server/orchestration/adapters";
import { persistedDispatchFailure } from "@/server/orchestration/dispatch-warning";

function nowIsoFromMs(nowMs: number) {
  return new Date(nowMs).toISOString();
}

function createAuditId() {
  return `audit-${crypto.randomUUID()}`;
}

function progressForState(state: TranscriptJob["state"]) {
  if (state === "completed") {
    return 100;
  }
  if (state === "partial_result") {
    return 70;
  }
  if (state === "running") {
    return 40;
  }
  return 0;
}

function ensureCollections(state: AppState) {
  const mutableState = state as AppState & {
    ingestionSessions?: IngestionSession[];
    transcriptJobs?: TranscriptJob[];
  };

  if (!mutableState.ingestionSessions) {
    mutableState.ingestionSessions = [];
  }
  if (!mutableState.transcriptJobs) {
    mutableState.transcriptJobs = [];
  }

  return mutableState as AppState;
}

function addAuditEvent(
  state: AppState,
  event: Pick<AuditEvent, "workspaceId" | "recordingId" | "actorRole" | "type" | "detail">,
  nowMs: number,
) {
  state.auditEvents.unshift({
    ...event,
    actorUserId: null,
    actorDisplayName: null,
    effectiveRole: event.actorRole,
    adminActionSessionId: null,
    id: createAuditId(),
    metadata: EMPTY_AUDIT_METADATA,
    createdAt: nowIsoFromMs(nowMs),
  });
}

function resolveRecordingRefs(state: AppState, recordingId: string) {
  const recording = state.recordings.find((entry) => entry.id === recordingId);
  if (!recording) {
    throw new Error("Recording not found.");
  }

  const session = state.ingestionSessions.find(
    (entry) => entry.id === recording.ingestionSessionId,
  );
  const job = state.transcriptJobs.find((entry) => entry.id === recording.transcriptJobId);

  if (!session || !job) {
    throw new Error("Recording orchestration state is incomplete.");
  }

  return { recording, session, job };
}

function bootstrapIngestionSession(recording: Recording): IngestionSession {
  const timestamp =
    recording.integrityState === "verified" ? recording.createdAt : recording.updatedAt;

  return {
    id: `ingest-bootstrap-${recording.id}`,
    recordingId: recording.id,
    source: recording.source,
    state: recording.integrityState,
    adapter: "mock-governed-engine",
    createdByUserId: null,
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
    startedAt: timestamp,
    verifiedAt: recording.integrityState === "verified" ? recording.updatedAt : null,
    lastError:
      recording.integrityState === "verification_failed"
        ? "Legacy state imported with verification failure."
        : null,
    verificationSummary: recording.verificationSummary,
    resumeToken: `resume-bootstrap-${recording.id}`,
    bytesReceived: null,
    bytesExpected: null,
  };
}

function bootstrapTranscriptJob(recording: Recording): TranscriptJob {
  return {
    id: `job-bootstrap-${recording.id}`,
    recordingId: recording.id,
    state: recording.transcriptJobState,
    adapter: "mock-governed-engine",
    claimedByWorkerId: null,
    attemptCount:
      recording.transcriptJobState === "completed" || recording.transcriptJobState === "failed"
        ? 1
        : 0,
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
    startedAt:
      recording.transcriptJobState === "queued" ? null : recording.updatedAt,
    completedAt:
      recording.transcriptJobState === "completed" ? recording.updatedAt : null,
    lastHeartbeatAt:
      recording.transcriptJobState === "running" ||
      recording.transcriptJobState === "partial_result"
        ? recording.updatedAt
        : null,
    etaSeconds:
      recording.transcriptJobState === "completed"
        ? 0
        : recording.transcriptJobState === "queued"
          ? 90
          : 30,
    progressPercent: progressForState(recording.transcriptJobState),
    transcribedUntilMs: null,
    audioDurationMs: null,
    segmentsSeen: null,
    outputRevisionId:
      recording.transcriptJobState === "completed" ? recording.currentRevisionId : null,
    lastError:
      recording.transcriptJobState === "failed"
        ? "Legacy state imported with transcription failure."
        : null,
    diarizationStatus:
      recording.transcriptJobState === "completed" ? "available" : "pending",
  };
}

export function normalizeState(state: AppState): AppState {
  ensureCollections(state);

  for (const recording of state.recordings) {
    if (recording.ingestionSessionId === undefined) {
      recording.ingestionSessionId = null;
    }
    if (recording.transcriptJobId === undefined) {
      recording.transcriptJobId = null;
    }
    // Pre-v12 states predate the tier picker: the recording ran/on the
    // engine default, so absent means default.
    if (recording.transcriptModel === undefined) {
      recording.transcriptModel = null;
    }

    let session = state.ingestionSessions.find(
      (entry) => entry.id === recording.ingestionSessionId,
    );
    if (!session) {
      session = state.ingestionSessions.find(
        (entry) => entry.recordingId === recording.id,
      );
    }
    if (!session) {
      session = bootstrapIngestionSession(recording);
      state.ingestionSessions.unshift(session);
    }
    recording.ingestionSessionId = session.id;

    let job = state.transcriptJobs.find(
      (entry) => entry.id === recording.transcriptJobId,
    );
    if (!job) {
      job = state.transcriptJobs.find((entry) => entry.recordingId === recording.id);
    }
    if (!job) {
      job = bootstrapTranscriptJob(recording);
      state.transcriptJobs.unshift(job);
    }
    recording.transcriptJobId = job.id;
  }

  return state;
}

function completeDraftIfNeeded(
  state: AppState,
  recording: Recording,
  job: TranscriptJob,
  summary: string,
  outputSegments: NonNullable<
    ReturnType<CanonicalOrchestrationAdapter["stepTranscriptJob"]>
  >["outputSegments"],
) {
  if (recording.currentRevisionId || !outputSegments) {
    return;
  }

  const revision = createSystemDraftRevision({
    state,
    recordingId: recording.id,
    segments: outputSegments,
    summary,
  });
  job.outputRevisionId = revision.id;
}

export function synchronizeOrchestration(
  state: AppState,
  options?: {
    adapter?: CanonicalOrchestrationAdapter;
    nowMs?: number;
  },
) {
  normalizeState(state);

  const nowMs = options?.nowMs ?? Date.now();

  for (const recording of state.recordings) {
    const session = state.ingestionSessions.find(
      (entry) => entry.id === recording.ingestionSessionId,
    );
    const job = state.transcriptJobs.find(
      (entry) => entry.id === recording.transcriptJobId,
    );

    if (!session || !job) {
      continue;
    }

    const adapter =
      options?.adapter ??
      resolveAdapter(job.adapter || session.adapter);

    const verificationStep = adapter.stepVerification({
      recording,
      session,
      nowMs,
    });
    if (verificationStep) {
      const previousState = session.state;
      session.state = verificationStep.nextState;
      session.adapter = adapter.id;
      session.updatedAt = nowIsoFromMs(nowMs);
      session.lastError = verificationStep.lastError;
      session.verificationSummary = verificationStep.summary;
      if (verificationStep.nextState === "verified") {
        session.verifiedAt = nowIsoFromMs(nowMs);
      }

      recording.integrityState = verificationStep.nextState;
      recording.verificationSummary = verificationStep.summary;
      recording.updatedAt = nowIsoFromMs(nowMs);

      if (previousState !== verificationStep.nextState) {
        addAuditEvent(
          state,
          {
            workspaceId: recording.workspaceId,
            recordingId: recording.id,
            actorRole: "system",
            type:
              verificationStep.nextState === "verified"
                ? "recording.verified"
                : "recording.verification_failed",
            detail: verificationStep.summary,
          },
          nowMs,
        );
      }
    }

    const transcriptStep = adapter.stepTranscriptJob({
      recording,
      session,
      job,
      nowMs,
    });

    if (!transcriptStep) {
      continue;
    }

    const previousState = job.state;
    job.state = transcriptStep.nextState;
    job.adapter = adapter.id;
    job.claimedByWorkerId = transcriptStep.nextState === "completed" ? null : job.claimedByWorkerId;
    job.updatedAt = nowIsoFromMs(nowMs);
    job.lastHeartbeatAt = nowIsoFromMs(nowMs);
    job.progressPercent = transcriptStep.progressPercent;
    job.etaSeconds = transcriptStep.etaSeconds;
    job.diarizationStatus = transcriptStep.diarizationStatus;
    job.lastError = transcriptStep.lastError;
    if (previousState === "queued" && transcriptStep.nextState === "running") {
      job.startedAt = nowIsoFromMs(nowMs);
    }
    if (transcriptStep.nextState === "completed") {
      job.completedAt = nowIsoFromMs(nowMs);
    }

    recording.transcriptJobState = transcriptStep.nextState;
    recording.updatedAt = nowIsoFromMs(nowMs);

    if (previousState !== transcriptStep.nextState) {
      const auditType =
        transcriptStep.nextState === "running"
          ? "transcription.started"
          : transcriptStep.nextState === "partial_result"
            ? "transcription.partial"
            : "transcription.completed";

      addAuditEvent(
        state,
        {
          workspaceId: recording.workspaceId,
          recordingId: recording.id,
          actorRole: "system",
          type: auditType,
          detail: transcriptStep.summary,
        },
        nowMs,
      );
    }

    if (transcriptStep.nextState === "completed") {
      completeDraftIfNeeded(
        state,
        recording,
        job,
        transcriptStep.summary,
        transcriptStep.outputSegments,
      );
    }
  }
}

export function noteOrchestrationDispatchFailure(
  recordingId: string,
  detail: string,
  state?: AppState,
) {
  const workingState = state;
  if (!workingState) {
    return;
  }

  normalizeState(workingState);
  const { recording, session, job } = resolveRecordingRefs(workingState, recordingId);
  const nowMs = Date.now();
  session.lastError = persistedDispatchFailure(detail);
  session.updatedAt = nowIsoFromMs(nowMs);
  session.verificationSummary = detail;
  job.lastError = detail;
  job.updatedAt = nowIsoFromMs(nowMs);
  recording.verificationSummary = detail;
  recording.updatedAt = nowIsoFromMs(nowMs);
  addAuditEvent(
    workingState,
    {
      workspaceId: recording.workspaceId,
      recordingId,
      actorRole: "system",
      type: "recording.verification_failed",
      detail,
    },
    nowMs,
  );
}

export type OrchestrationWebhookPayload = {
  recordingId: string;
  eventAt?: string;
  ingestionSession?: {
    state?: IngestionSession["state"];
    verificationSummary?: string | null;
    lastError?: string | null;
    bytesReceived?: number | null;
    bytesExpected?: number | null;
    resumeToken?: string | null;
  };
  transcriptJob?: {
    state?: TranscriptJob["state"];
    progressPercent?: number | null;
    etaSeconds?: number | null;
    diarizationStatus?: TranscriptJob["diarizationStatus"];
    lastError?: string | null;
    summary?: string | null;
  };
  transcript?: {
    summary?: string | null;
    segments?: TranscriptSegment[];
  };
};

export function applyOrchestrationWebhookUpdate(
  state: AppState,
  payload: OrchestrationWebhookPayload,
) {
  normalizeState(state);
  const { recording, session, job } = resolveRecordingRefs(state, payload.recordingId);
  const nowMs = payload.eventAt ? Date.parse(payload.eventAt) || Date.now() : Date.now();

  if (payload.ingestionSession) {
    const previousState = session.state;
    if (payload.ingestionSession.state) {
      session.state = payload.ingestionSession.state;
      recording.integrityState = payload.ingestionSession.state;
      if (payload.ingestionSession.state === "verified") {
        session.verifiedAt = nowIsoFromMs(nowMs);
      }
    }
    if (payload.ingestionSession.verificationSummary !== undefined) {
      session.verificationSummary = payload.ingestionSession.verificationSummary;
      recording.verificationSummary = payload.ingestionSession.verificationSummary;
    }
    if (payload.ingestionSession.lastError !== undefined) {
      session.lastError = payload.ingestionSession.lastError;
    }
    if (payload.ingestionSession.bytesReceived !== undefined) {
      session.bytesReceived = payload.ingestionSession.bytesReceived;
    }
    if (payload.ingestionSession.bytesExpected !== undefined) {
      session.bytesExpected = payload.ingestionSession.bytesExpected;
    }
    if (payload.ingestionSession.resumeToken !== undefined) {
      session.resumeToken = payload.ingestionSession.resumeToken;
    }
    session.updatedAt = nowIsoFromMs(nowMs);
    recording.updatedAt = nowIsoFromMs(nowMs);

    if (payload.ingestionSession.state && previousState !== payload.ingestionSession.state) {
      addAuditEvent(
        state,
        {
          workspaceId: recording.workspaceId,
          recordingId: recording.id,
          actorRole: "system",
          type:
            payload.ingestionSession.state === "verified"
              ? "recording.verified"
              : "recording.verification_failed",
          detail:
            payload.ingestionSession.verificationSummary ??
            "Ingestion session updated by external engine.",
        },
        nowMs,
      );
    }
  }

  if (payload.transcriptJob) {
    const previousState = job.state;
    if (payload.transcriptJob.state) {
      job.state = payload.transcriptJob.state;
      recording.transcriptJobState = payload.transcriptJob.state;
      if (payload.transcriptJob.state === "running" && !job.startedAt) {
        job.startedAt = nowIsoFromMs(nowMs);
      }
      if (payload.transcriptJob.state === "completed") {
        job.completedAt = nowIsoFromMs(nowMs);
      }
    }
    if (payload.transcriptJob.progressPercent !== undefined) {
      job.progressPercent = payload.transcriptJob.progressPercent;
    }
    if (payload.transcriptJob.etaSeconds !== undefined) {
      job.etaSeconds = payload.transcriptJob.etaSeconds;
    }
    if (payload.transcriptJob.diarizationStatus !== undefined) {
      job.diarizationStatus = payload.transcriptJob.diarizationStatus;
    }
    if (payload.transcriptJob.lastError !== undefined) {
      job.lastError = payload.transcriptJob.lastError;
    }

    job.updatedAt = nowIsoFromMs(nowMs);
    job.lastHeartbeatAt = nowIsoFromMs(nowMs);
    recording.updatedAt = nowIsoFromMs(nowMs);

    if (payload.transcriptJob.state && previousState !== payload.transcriptJob.state) {
      const auditType =
        payload.transcriptJob.state === "running"
          ? "transcription.started"
          : payload.transcriptJob.state === "partial_result"
            ? "transcription.partial"
            : "transcription.completed";

      addAuditEvent(
        state,
        {
          workspaceId: recording.workspaceId,
          recordingId: recording.id,
          actorRole: "system",
          type: auditType,
          detail:
            payload.transcriptJob.summary ??
            "Transcript job updated by external engine.",
        },
        nowMs,
      );
    }
  }

  if (
    payload.transcript?.segments &&
    Array.isArray(payload.transcript.segments) &&
    job.state === "completed" &&
    !recording.currentRevisionId
  ) {
    const revision = createSystemDraftRevision({
      state,
      recordingId: recording.id,
      segments: payload.transcript.segments,
      summary:
        payload.transcript.summary ??
        payload.transcriptJob?.summary ??
        "Initial transcript draft from external engine.",
    });
    job.outputRevisionId = revision.id;
    job.updatedAt = nowIsoFromMs(nowMs);
    recording.updatedAt = nowIsoFromMs(nowMs);
  }
}
