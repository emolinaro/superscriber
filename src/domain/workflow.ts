import {
  AppState,
  AuditEvent,
  IngestionSession,
  Principal,
  Recording,
  TranscriptJob,
  TranscriptRevision,
  UserRole,
  WorkspaceBucket,
} from "@/domain/models";
import { actorContextForPrincipal, type ActorContext } from "@/server/casefile/audit";
import { EMPTY_AUDIT_METADATA } from "@/server/db/mappers";

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nextRevisionVersion(state: AppState, recordingId: string) {
  const versions = state.revisions
    .filter((entry) => entry.recordingId === recordingId)
    .map((entry) => entry.version);
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

export function bucketRecording(recording: Recording): WorkspaceBucket {
  if (
    recording.integrityState === "capturing" ||
    recording.integrityState === "uploading" ||
    recording.integrityState === "interrupted" ||
    recording.integrityState === "verification_failed" ||
    recording.transcriptJobState === "failed" ||
    recording.transcriptJobState === "cancelled"
  ) {
    return "needs_ingest";
  }

  if (recording.integrityState === "verifying") {
    return "verifying";
  }

  if (
    recording.transcriptJobState === "queued" ||
    recording.transcriptJobState === "running" ||
    recording.transcriptJobState === "partial_result"
  ) {
    return "transcribing";
  }

  if (recording.pendingRevisionId) {
    return "pending_approval";
  }

  if (recording.approvedRevisionId) {
    return "approved";
  }

  return "needs_review";
}

function addAuditEvent(
  state: AppState,
  event: Pick<AuditEvent, "workspaceId" | "recordingId" | "type" | "detail"> & {
    actor?: ActorContext;
    actorRole?: AuditEvent["actorRole"];
  },
) {
  const actor =
    event.actor ?? {
      actorRole: event.actorRole ?? "system",
      actorUserId: null,
      actorDisplayName: null,
      effectiveRole: event.actorRole ?? "system",
      adminActionSessionId: null,
    };

  state.auditEvents.unshift({
    workspaceId: event.workspaceId,
    recordingId: event.recordingId,
    actorRole: actor.actorRole,
    actorUserId: actor.actorUserId,
    actorDisplayName: actor.actorDisplayName,
    effectiveRole: actor.effectiveRole,
    adminActionSessionId: actor.adminActionSessionId,
    type: event.type,
    detail: event.detail,
    id: createId("audit"),
    metadata: EMPTY_AUDIT_METADATA,
    createdAt: nowIso(),
  });
}

function createIngestionSession(
  recording: Recording,
  mediaBytes: number | null,
  adapterId: string,
  options?: {
    id?: string;
    state?: IngestionSession["state"];
    verificationSummary?: string;
    bytesReceived?: number | null;
    startedAt?: string | null;
    createdByUserId?: string | null;
  },
): IngestionSession {
  const timestamp = nowIso();
  const nextState = options?.state ?? "verifying";
  return {
    id: options?.id ?? createId("ingest"),
    recordingId: recording.id,
    source: recording.source,
    state: nextState,
    adapter: adapterId,
    createdByUserId: options?.createdByUserId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: options?.startedAt ?? timestamp,
    verifiedAt: nextState === "verified" ? timestamp : null,
    lastError: null,
    verificationSummary:
      options?.verificationSummary ?? "Awaiting server-side verification.",
    resumeToken: createId("resume"),
    bytesReceived: options?.bytesReceived ?? mediaBytes,
    bytesExpected: mediaBytes,
  };
}

function createTranscriptJob(recording: Recording, adapterId: string): TranscriptJob {
  const timestamp = nowIso();
  return {
    id: createId("job"),
    recordingId: recording.id,
    state: "queued",
    adapter: adapterId,
    claimedByWorkerId: null,
    attemptCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
    lastHeartbeatAt: null,
    etaSeconds: 90,
    progressPercent: null,
    transcribedUntilMs: null,
    audioDurationMs: null,
    segmentsSeen: null,
    outputRevisionId: null,
    lastError: null,
    diarizationStatus: "pending",
  };
}

export function createSystemDraftRevision(params: {
  state: AppState;
  recordingId: string;
  segments: TranscriptRevision["segments"];
  summary: string;
}) {
  const recording = params.state.recordings.find(
    (entry) => entry.id === params.recordingId,
  );
  if (!recording) {
    throw new Error("Recording not found.");
  }

  const revision: TranscriptRevision = {
    id: createId("rev"),
    recordingId: params.recordingId,
    version: nextRevisionVersion(params.state, recording.id),
    state: "draft",
    basedOnRevisionId: null,
    createdByRole: "system",
    createdByUserId: null,
    createdAt: nowIso(),
    submittedByUserId: null,
    submittedAt: null,
    approvedAt: null,
    summary: params.summary,
    segments: params.segments,
  };

  params.state.revisions.push(revision);
  recording.currentRevisionId = revision.id;

  recording.updatedAt = nowIso();
  return revision;
}

export function createRecordingEntry(params: {
  state: AppState;
  workspaceId: string;
  title: string;
  source: Recording["source"];
  mediaKind: Recording["mediaKind"];
  mimeType: string | null;
  mediaPath: string | null;
  originalFileName: string | null;
  languageHint: string;
  role: UserRole;
  adapterId?: string;
  transcriptModel?: string | null;
}) {
  const mediaBytes = null;
  const adapterId = params.adapterId ?? "mock-governed-engine";
  const recording: Recording = {
    id: createId("rec"),
    workspaceId: params.workspaceId,
    title: params.title,
    source: params.source,
    mediaKind: params.mediaKind,
    mimeType: params.mimeType,
    mediaPath: params.mediaPath,
    originalFileName: params.originalFileName,
    languageHint: params.languageHint,
    transcriptModel: params.transcriptModel ?? null,
    uploadedByRole: params.role,
    uploadedByUserId: null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verifying",
    transcriptJobState: "queued",
    currentRevisionId: null,
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Awaiting server-side verification.",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    automationCursor: null,
  };

  const ingestionSession = createIngestionSession(recording, mediaBytes, adapterId);
  const transcriptJob = createTranscriptJob(recording, adapterId);
  recording.ingestionSessionId = ingestionSession.id;
  recording.transcriptJobId = transcriptJob.id;

  params.state.recordings.unshift(recording);
  params.state.ingestionSessions.unshift(ingestionSession);
  params.state.transcriptJobs.unshift(transcriptJob);
  addAuditEvent(params.state, {
    workspaceId: recording.workspaceId,
    recordingId: recording.id,
    actorRole: params.role,
    type: "recording.created",
    detail: `${params.source === "record" ? "Browser recording" : "Upload"} received and queued for verification.`,
  });

  return recording;
}

function resolveUploadRefs(state: AppState, sessionId: string) {
  const session = state.ingestionSessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Upload session not found.");
  }

  const recording = state.recordings.find((entry) => entry.id === session.recordingId);
  if (!recording) {
    throw new Error("Recording not found.");
  }

  const job = state.transcriptJobs.find((entry) => entry.id === recording.transcriptJobId);
  if (!job) {
    throw new Error("Transcript job not found.");
  }

  return { session, recording, job };
}

export function createUploadSessionEntry(params: {
  state: AppState;
  workspaceId: string;
  title: string;
  source: Recording["source"];
  mediaKind: Recording["mediaKind"];
  mimeType: string | null;
  originalFileName: string | null;
  languageHint: string;
  /** demo-advanced-model-picker: per-recording engine model; absent = default. */
  transcriptModel?: string | null;
  principal: Principal;
  bytesExpected: number;
  adapterId?: string;
  sessionId?: string;
}) {
  const adapterId = params.adapterId ?? "mock-governed-engine";
  const timestamp = nowIso();
  const recording: Recording = {
    id: createId("rec"),
    workspaceId: params.workspaceId,
    title: params.title,
    source: params.source,
    mediaKind: params.mediaKind,
    mimeType: params.mimeType,
    mediaPath: null,
    originalFileName: params.originalFileName,
    languageHint: params.languageHint,
    transcriptModel: params.transcriptModel ?? null,
    uploadedByRole: params.principal.role,
    uploadedByUserId: params.principal.userId,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "uploading",
    transcriptJobState: "queued",
    currentRevisionId: null,
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary:
      "Upload session started. Continue from the last committed byte if the transfer is interrupted.",
    createdAt: timestamp,
    updatedAt: timestamp,
    automationCursor: null,
  };

  const ingestionSession = createIngestionSession(recording, params.bytesExpected, adapterId, {
    id: params.sessionId,
    state: "uploading",
    verificationSummary:
      "Upload session started. Continue from the last committed byte if the transfer is interrupted.",
    bytesReceived: 0,
    createdByUserId: params.principal.userId,
  });
  const transcriptJob = createTranscriptJob(recording, adapterId);
  recording.ingestionSessionId = ingestionSession.id;
  recording.transcriptJobId = transcriptJob.id;

  params.state.recordings.unshift(recording);
  params.state.ingestionSessions.unshift(ingestionSession);
  params.state.transcriptJobs.unshift(transcriptJob);
  addAuditEvent(params.state, {
    workspaceId: recording.workspaceId,
    recordingId: recording.id,
    actor: actorContextForPrincipal(params.principal),
    type: "recording.created",
    detail: `${params.source === "record" ? "Browser recording" : "Upload"} session started.`,
  });

  return { recording, ingestionSession, transcriptJob };
}

export function noteUploadProgress(params: {
  state: AppState;
  sessionId: string;
  bytesReceived: number;
}) {
  const { session, recording } = resolveUploadRefs(params.state, params.sessionId);
  session.bytesReceived = params.bytesReceived;
  session.state = "uploading";
  session.updatedAt = nowIso();
  session.lastError = null;
  session.verificationSummary =
    params.bytesReceived === session.bytesExpected
      ? "Upload bytes received. Finalize to begin governed verification."
      : "Upload in progress. Resume continues from the last committed byte.";

  recording.integrityState = "uploading";
  recording.verificationSummary = session.verificationSummary;
  recording.updatedAt = nowIso();

  return { session, recording };
}

export function expireUploadSession(params: {
  state: AppState;
  sessionId: string;
  detail: string;
}) {
  const { session, recording, job } = resolveUploadRefs(params.state, params.sessionId);
  session.state = "interrupted";
  session.lastError = params.detail;
  session.verificationSummary = params.detail;
  session.updatedAt = nowIso();

  recording.integrityState = "interrupted";
  recording.verificationSummary = params.detail;
  recording.updatedAt = nowIso();

  job.lastError = params.detail;
  job.updatedAt = nowIso();

  addAuditEvent(params.state, {
    workspaceId: recording.workspaceId,
    recordingId: recording.id,
    actorRole: "system",
    type: "recording.verification_failed",
    detail: params.detail,
  });
}

export function failUploadSession(params: {
  state: AppState;
  sessionId: string;
  detail: string;
}) {
  const { session, recording, job } = resolveUploadRefs(params.state, params.sessionId);
  session.state = "verification_failed";
  session.lastError = params.detail;
  session.verificationSummary = params.detail;
  session.updatedAt = nowIso();

  recording.integrityState = "verification_failed";
  recording.verificationSummary = params.detail;
  recording.updatedAt = nowIso();

  job.state = "failed";
  job.lastError = params.detail;
  job.updatedAt = nowIso();
  recording.transcriptJobState = "failed";

  addAuditEvent(params.state, {
    workspaceId: recording.workspaceId,
    recordingId: recording.id,
    actorRole: "system",
    type: "recording.verification_failed",
    detail: params.detail,
  });
}

export function finalizeUploadSession(params: {
  state: AppState;
  sessionId: string;
  mediaPath: string;
  mimeType: string | null;
  principal: Principal;
}) {
  const { session, recording, job } = resolveUploadRefs(params.state, params.sessionId);
  const timestamp = nowIso();
  const isExternalVerification = session.adapter === "external-webhook-engine";
  const nextIntegrityState = isExternalVerification ? "verifying" : "verified";
  const verificationSummary = isExternalVerification
    ? "Upload complete. Server-side verification is starting."
    : "Upload verified locally and queued for transcription.";

  session.state = nextIntegrityState;
  session.updatedAt = timestamp;
  session.lastError = null;
  session.verificationSummary = verificationSummary;
  session.verifiedAt = nextIntegrityState === "verified" ? timestamp : null;

  recording.mediaPath = params.mediaPath;
  recording.mimeType = params.mimeType;
  recording.integrityState = nextIntegrityState;
  recording.transcriptJobState = "queued";
  recording.verificationSummary = verificationSummary;
  recording.updatedAt = timestamp;

  job.state = "queued";
  job.updatedAt = timestamp;
  job.lastError = null;

  addAuditEvent(params.state, {
    workspaceId: recording.workspaceId,
    recordingId: recording.id,
    actor: actorContextForPrincipal(params.principal),
    type: "recording.created",
    detail: verificationSummary,
  });

  return { session, recording, job };
}
