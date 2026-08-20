import { AppState, TranscriptJob, TranscriptSegment } from "@/domain/models";
import { createSystemDraftRevision } from "@/domain/workflow";
import { EMPTY_AUDIT_METADATA } from "@/server/db/mappers";
import { getAppDbBundle, type AppDatabaseBundle } from "@/server/db/client";
import { normalizeState } from "@/server/orchestration/service";
import { readState, withState } from "@/server/store";

const DEFAULT_STALE_HEARTBEAT_MS = 1000 * 60 * 2;
const MAX_JOB_ATTEMPTS = 3;

type JobRefs = {
  state: AppState;
  job: TranscriptJob;
  recording: AppState["recordings"][number];
  session: AppState["ingestionSessions"][number] | null;
};

export type InternalTranscriptJobClaim = {
  workerId: string;
  jobId: string;
  recordingId: string;
  workspaceId: string;
  title: string;
  source: string;
  mediaKind: string;
  mimeType: string | null;
  mediaPath: string | null;
  originalFileName: string | null;
  languageHint: string;
  transcriptModel: string | null;
  ingestionSessionId: string | null;
  transcriptJobState: TranscriptJob["state"];
  attemptCount: number;
  diarizationStatus: TranscriptJob["diarizationStatus"];
};

export type InternalTranscriptJobSnapshot = {
  jobId: string;
  recordingId: string;
  state: TranscriptJob["state"];
  attemptCount: number;
  claimedByWorkerId: string | null;
  progressPercent: number | null;
  etaSeconds: number | null;
  transcribedUntilMs?: number | null;
  audioDurationMs?: number | null;
  segmentsSeen?: number | null;
  lastHeartbeatAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  diarizationStatus: TranscriptJob["diarizationStatus"];
  outputRevisionId: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function createAuditId() {
  return `audit-${crypto.randomUUID()}`;
}

function activeBundle(bundle?: AppDatabaseBundle) {
  return bundle ?? getAppDbBundle();
}

function buildClaim(state: AppState, workerId: string, jobId: string): InternalTranscriptJobClaim {
  const job = state.transcriptJobs.find((entry) => entry.id === jobId);
  if (!job) {
    throw new Error("Transcript job not found.");
  }

  const recording = state.recordings.find((entry) => entry.id === job.recordingId);
  if (!recording) {
    throw new Error("Recording not found.");
  }

  return {
    workerId,
    jobId: job.id,
    recordingId: recording.id,
    workspaceId: recording.workspaceId,
    title: recording.title,
    source: recording.source,
    mediaKind: recording.mediaKind,
    mimeType: recording.mimeType,
    mediaPath: recording.mediaPath,
    originalFileName: recording.originalFileName,
    languageHint: recording.languageHint,
    transcriptModel: recording.transcriptModel,
    ingestionSessionId: recording.ingestionSessionId,
    transcriptJobState: job.state,
    attemptCount: job.attemptCount,
    diarizationStatus: job.diarizationStatus,
  };
}

export function engineProgressFromMs(
  transcribedUntilMs: number | null,
  audioDurationMs: number | null,
): number | null {
  if (
    typeof transcribedUntilMs === "number" &&
    typeof audioDurationMs === "number" &&
    audioDurationMs > 0
  ) {
    return Math.min(99, Math.max(0, Math.floor((transcribedUntilMs / audioDurationMs) * 100)));
  }
  return null;
}

function buildSnapshot(job: TranscriptJob): InternalTranscriptJobSnapshot {
  return {
    jobId: job.id,
    recordingId: job.recordingId,
    state: job.state,
    attemptCount: job.attemptCount,
    claimedByWorkerId: job.claimedByWorkerId,
    progressPercent: job.progressPercent,
    etaSeconds: job.etaSeconds,
    transcribedUntilMs: job.transcribedUntilMs,
    audioDurationMs: job.audioDurationMs,
    segmentsSeen: job.segmentsSeen,
    lastHeartbeatAt: job.lastHeartbeatAt,
    completedAt: job.completedAt,
    lastError: job.lastError,
    diarizationStatus: job.diarizationStatus,
    outputRevisionId: job.outputRevisionId,
  };
}

function resolveJobRefs(state: AppState, jobId: string): JobRefs {
  normalizeState(state);

  const job = state.transcriptJobs.find((entry) => entry.id === jobId);
  if (!job) {
    throw new Error("Transcript job not found.");
  }

  const recording = state.recordings.find((entry) => entry.id === job.recordingId);
  if (!recording) {
    throw new Error("Recording not found.");
  }

  const session =
    state.ingestionSessions.find((entry) => entry.id === recording.ingestionSessionId) ?? null;

  return { state, job, recording, session };
}

function assertClaimOwner(job: TranscriptJob, workerId: string) {
  if (job.claimedByWorkerId !== workerId) {
    throw new Error("Transcript job is not claimed by this worker.");
  }
}

function addAuditEvent(
  state: AppState,
  params: {
    workspaceId: string;
    recordingId: string;
    type: AppState["auditEvents"][number]["type"];
    detail: string;
  },
) {
  state.auditEvents.unshift({
    id: createAuditId(),
    workspaceId: params.workspaceId,
    recordingId: params.recordingId,
    actorRole: "system",
    actorUserId: null,
    actorDisplayName: null,
    effectiveRole: "system",
    adminActionSessionId: null,
    type: params.type,
    detail: params.detail,
    metadata: EMPTY_AUDIT_METADATA,
    createdAt: nowIso(),
  });
}

export function claimAvailableTranscriptJob(params: {
  workerId: string;
  staleAfterMs?: number;
  bundle?: AppDatabaseBundle;
}) {
  const bundle = activeBundle(params.bundle);
  readState(bundle.db);

  const staleCutoff = new Date(
    Date.now() - (params.staleAfterMs ?? DEFAULT_STALE_HEARTBEAT_MS),
  ).toISOString();
  const claimedAt = nowIso();

  const claimTransaction = bundle.sqlite.transaction(() => {
    const candidate = bundle.sqlite
      .prepare(
        `
          SELECT
            j.id AS jobId,
            j.recording_id AS recordingId,
            r.workspace_id AS workspaceId,
            j.state AS previousState
          FROM transcript_jobs j
          INNER JOIN recordings r ON r.id = j.recording_id
          LEFT JOIN ingestion_sessions s ON s.id = r.ingestion_session_id
          WHERE r.integrity_state = 'verified'
            AND r.media_path IS NOT NULL
            AND (s.state IS NULL OR s.state = 'verified')
            AND (
              j.state = 'queued'
              OR (
                j.state IN ('running', 'partial_result')
                AND (j.last_heartbeat_at IS NULL OR j.last_heartbeat_at < @staleCutoff)
              )
            )
          ORDER BY
            CASE j.state WHEN 'queued' THEN 0 ELSE 1 END,
            r.updated_at ASC
          LIMIT 1
        `,
      )
      .get({ staleCutoff }) as
      | {
          jobId: string;
          recordingId: string;
          workspaceId: string;
          previousState: TranscriptJob["state"];
        }
      | undefined;

    if (!candidate) {
      return null;
    }

    const claimResult = bundle.sqlite
      .prepare(
        `
          UPDATE transcript_jobs
          SET
            state = 'running',
            adapter = 'internal-python-worker',
            claimed_by_worker_id = @workerId,
            attempt_count = attempt_count + 1,
            updated_at = @claimedAt,
            started_at = COALESCE(started_at, @claimedAt),
            last_heartbeat_at = @claimedAt,
            eta_seconds = COALESCE(eta_seconds, 90),
            progress_percent = NULL,
            transcribed_until_ms = NULL,
            audio_duration_ms = NULL,
            segments_seen = NULL,
            last_error = NULL,
            last_error_kind = NULL,
            last_error_technical = NULL
          WHERE id = @jobId
            AND (
              state = 'queued'
              OR (
                state IN ('running', 'partial_result')
                AND (last_heartbeat_at IS NULL OR last_heartbeat_at < @staleCutoff)
              )
            )
        `,
      )
      .run({
        workerId: params.workerId,
        claimedAt,
        jobId: candidate.jobId,
        staleCutoff,
      });

    if (claimResult.changes !== 1) {
      return null;
    }

    bundle.sqlite
      .prepare(
        `
          UPDATE recordings
          SET transcript_job_state = 'running', updated_at = @claimedAt
          WHERE id = @recordingId
        `,
      )
      .run({
        claimedAt,
        recordingId: candidate.recordingId,
      });

    const detail =
      candidate.previousState === "queued"
        ? `Transcript job claimed by internal worker ${params.workerId}.`
        : `Transcript job reclaimed by internal worker ${params.workerId} after a stale heartbeat.`;

    bundle.sqlite
      .prepare(
        `
          INSERT INTO audit_events (
            id,
            workspace_id,
            recording_id,
            actor_role,
            type,
            detail,
            created_at
          ) VALUES (
            @id,
            @workspaceId,
            @recordingId,
            'system',
            'transcription.started',
            @detail,
            @claimedAt
          )
        `,
      )
      .run({
        id: createAuditId(),
        workspaceId: candidate.workspaceId,
        recordingId: candidate.recordingId,
        detail,
        claimedAt,
      });

    bundle.sqlite
      .prepare(
        `
          UPDATE app_state_meta
          SET state_version = state_version + 1
          WHERE id = 1
        `,
      )
      .run();

    return candidate;
  });
  const claimRow = claimTransaction.immediate();

  if (!claimRow) {
    return null;
  }

  const state = readState(bundle.db);
  return buildClaim(state, params.workerId, claimRow.jobId);
}

export function heartbeatTranscriptJob(params: {
  jobId: string;
  workerId: string;
  state?: Extract<TranscriptJob["state"], "running" | "partial_result">;
  progressPercent?: number | null;
  etaSeconds?: number | null;
  diarizationStatus?: TranscriptJob["diarizationStatus"];
  transcribedUntilMs?: number | null;
  audioDurationMs?: number | null;
  segmentsSeen?: number | null;
  bundle?: AppDatabaseBundle;
}) {
  const bundle = activeBundle(params.bundle);

  return withState((state) => {
    const refs = resolveJobRefs(state, params.jobId);
    assertClaimOwner(refs.job, params.workerId);

    const previousState = refs.job.state;
    const nextState = params.state ?? refs.job.state;
    if (nextState !== "running" && nextState !== "partial_result") {
      throw new Error("Heartbeats may only keep a job running or mark it as partial_result.");
    }

    const timestamp = nowIso();
    refs.job.state = nextState;
    refs.job.adapter = "internal-python-worker";
    refs.job.updatedAt = timestamp;
    refs.job.lastHeartbeatAt = timestamp;
    refs.job.transcribedUntilMs = params.transcribedUntilMs ?? refs.job.transcribedUntilMs;
    refs.job.audioDurationMs = params.audioDurationMs ?? refs.job.audioDurationMs;
    refs.job.segmentsSeen = params.segmentsSeen ?? refs.job.segmentsSeen;

    const enginePercent =
      engineProgressFromMs(refs.job.transcribedUntilMs, refs.job.audioDurationMs);
    refs.job.progressPercent = enginePercent ?? refs.job.progressPercent;
    refs.job.etaSeconds = params.etaSeconds ?? refs.job.etaSeconds;
    refs.job.diarizationStatus = params.diarizationStatus ?? refs.job.diarizationStatus;
    refs.job.lastError = null;

    refs.recording.transcriptJobState = nextState;
    refs.recording.updatedAt = timestamp;

    if (previousState !== nextState && nextState === "partial_result") {
      addAuditEvent(state, {
        workspaceId: refs.recording.workspaceId,
        recordingId: refs.recording.id,
        type: "transcription.partial",
        detail: `Internal worker ${params.workerId} published a partial transcript result.`,
      });
    }

    return buildSnapshot(refs.job);
  }, bundle.db);
}

export function completeTranscriptJob(params: {
  jobId: string;
  workerId: string;
  summary: string;
  segments: TranscriptSegment[];
  diarizationStatus?: TranscriptJob["diarizationStatus"];
  bundle?: AppDatabaseBundle;
}) {
  const bundle = activeBundle(params.bundle);

  return withState((state) => {
    const refs = resolveJobRefs(state, params.jobId);
    assertClaimOwner(refs.job, params.workerId);

    const existingOutputRevision = refs.job.outputRevisionId
      ? state.revisions.find((entry) => entry.id === refs.job.outputRevisionId) ?? null
      : null;
    const currentRecordingRevision = refs.recording.currentRevisionId
      ? state.revisions.find((entry) => entry.id === refs.recording.currentRevisionId) ?? null
      : null;

    const nextRevision =
      existingOutputRevision ??
      currentRecordingRevision ??
      createSystemDraftRevision({
        state,
        recordingId: refs.recording.id,
        segments: params.segments,
        summary: params.summary,
      });

    const timestamp = nowIso();
    refs.job.state = "completed";
    refs.job.adapter = "internal-python-worker";
    refs.job.claimedByWorkerId = null;
    refs.job.updatedAt = timestamp;
    refs.job.lastHeartbeatAt = timestamp;
    refs.job.completedAt = timestamp;
    refs.job.progressPercent = 100;
    refs.job.etaSeconds = 0;
    refs.job.lastError = null;
    refs.job.diarizationStatus = params.diarizationStatus ?? "available";
    refs.job.outputRevisionId = nextRevision.id;

    refs.recording.transcriptJobState = "completed";
    refs.recording.updatedAt = timestamp;
    refs.recording.currentRevisionId = nextRevision.id;

    addAuditEvent(state, {
      workspaceId: refs.recording.workspaceId,
      recordingId: refs.recording.id,
      type: "transcription.completed",
      detail: params.summary,
    });

    return buildSnapshot(refs.job);
  }, bundle.db);
}

export function failTranscriptJob(params: {
  jobId: string;
  workerId: string;
  detail: string;
  retryable?: boolean;
  /** Stable, reviewer-quotable failure class from the worker
     (e.g. "mel-shape-mismatch"); null for legacy/unclassified failures. */
  errorClass?: string | null;
  /** Ops-only diagnostic (model name, mel counts, engine stack text) -
     never rendered on reviewer surfaces. */
  technicalDetail?: string | null;
  bundle?: AppDatabaseBundle;
}) {
  const bundle = activeBundle(params.bundle);

  return withState((state) => {
    const refs = resolveJobRefs(state, params.jobId);
    assertClaimOwner(refs.job, params.workerId);

    const exhausted = params.retryable === false || refs.job.attemptCount >= MAX_JOB_ATTEMPTS;
    const nextState: TranscriptJob["state"] = exhausted ? "failed" : "queued";
    const timestamp = nowIso();

    refs.job.state = nextState;
    refs.job.adapter = "internal-python-worker";
    refs.job.claimedByWorkerId = null;
    refs.job.updatedAt = timestamp;
    refs.job.lastHeartbeatAt = timestamp;
    refs.job.completedAt = exhausted ? timestamp : null;
    refs.job.progressPercent = exhausted ? refs.job.progressPercent : null;
    refs.job.etaSeconds = exhausted ? null : 90;
    if (!exhausted) {
      refs.job.transcribedUntilMs = null;
      refs.job.audioDurationMs = null;
      refs.job.segmentsSeen = null;
    }
    refs.job.lastError = params.detail;
    refs.job.lastErrorKind = params.errorClass ?? null;
    refs.job.lastErrorTechnical = params.technicalDetail ?? null;
    refs.job.diarizationStatus = exhausted ? refs.job.diarizationStatus : "pending";

    refs.recording.transcriptJobState = nextState;
    refs.recording.updatedAt = timestamp;

    addAuditEvent(state, {
      workspaceId: refs.recording.workspaceId,
      recordingId: refs.recording.id,
      type: "transcription.failed",
      detail: exhausted
        ? params.detail
        : `${params.detail} Job returned to queue for retry ${refs.job.attemptCount}/${MAX_JOB_ATTEMPTS}.`,
    });

    return buildSnapshot(refs.job);
  }, bundle.db);
}
