import {
  ApprovalRecord,
  AppState,
  AuditEvent,
  IngestionSession,
  Recording,
  TranscriptJob,
  TranscriptRevision,
  UserRole,
  WorkspaceBucket,
} from "@/domain/models";
import { evaluatePolicy } from "@/domain/policy";

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
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
  event: Omit<AuditEvent, "id" | "createdAt">,
) {
  state.auditEvents.unshift({
    ...event,
    id: createId("audit"),
    createdAt: nowIso(),
  });
}

function cloneSegments(segments: TranscriptRevision["segments"]) {
  return segments.map((segment) => ({ ...segment }));
}

function createIngestionSession(
  recording: Recording,
  mediaBytes: number | null,
  adapterId: string,
  options?: {
    state?: IngestionSession["state"];
    verificationSummary?: string;
    bytesReceived?: number | null;
    startedAt?: string | null;
  },
): IngestionSession {
  const timestamp = nowIso();
  const nextState = options?.state ?? "verifying";
  return {
    id: createId("ingest"),
    recordingId: recording.id,
    source: recording.source,
    state: nextState,
    adapter: adapterId,
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
    progressPercent: 0,
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

  const priorVersions = params.state.revisions
    .filter((entry) => entry.recordingId === recording.id)
    .map((entry) => entry.version);
  const nextVersion = priorVersions.length > 0 ? Math.max(...priorVersions) + 1 : 1;

  const revision: TranscriptRevision = {
    id: createId("rev"),
    recordingId: params.recordingId,
    version: nextVersion,
    state: "draft",
    basedOnRevisionId: null,
    createdByRole: "system",
    createdAt: nowIso(),
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
    uploadedByRole: params.role,
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
  role: UserRole;
  bytesExpected: number;
  adapterId?: string;
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
    uploadedByRole: params.role,
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
    state: "uploading",
    verificationSummary:
      "Upload session started. Continue from the last committed byte if the transfer is interrupted.",
    bytesReceived: 0,
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
    actorRole: params.role,
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
    actorRole: recording.uploadedByRole,
    type: "recording.created",
    detail: verificationSummary,
  });

  return { session, recording, job };
}

export function saveDraftRevision(params: {
  state: AppState;
  recordingId: string;
  role: UserRole;
  expectedCurrentRevisionId: string;
  segments: TranscriptRevision["segments"];
  summary: string;
}) {
  const recording = params.state.recordings.find(
    (entry) => entry.id === params.recordingId,
  );

  if (!recording) {
    throw new Error("Recording not found.");
  }

  const workspace = params.state.workspaces.find(
    (entry) => entry.id === recording.workspaceId,
  );

  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const decision = evaluatePolicy(workspace.policyProfileId, params.role);
  if (!decision.canEditDraft) {
    addAuditEvent(params.state, {
      workspaceId: workspace.id,
      recordingId: recording.id,
      actorRole: params.role,
      type: "policy.denied",
      detail: "Draft edit denied by regulated-mode policy.",
    });
    throw new Error("Your role cannot edit draft transcripts.");
  }

  if (recording.currentRevisionId !== params.expectedCurrentRevisionId) {
    throw new Error("A newer draft revision exists. Reload this recording and apply your changes again.");
  }

  const priorRevision = params.state.revisions.find(
    (entry) => entry.id === recording.currentRevisionId,
  );
  if (!priorRevision) {
    throw new Error("Current revision not found.");
  }

  if (
    priorRevision.state === "approved" &&
    recording.approvedRevisionId === priorRevision.id &&
    !decision.canReopenApprovedTranscript
  ) {
    addAuditEvent(params.state, {
      workspaceId: workspace.id,
      recordingId: recording.id,
      actorRole: params.role,
      type: "policy.denied",
      detail: "Approved transcript edit denied without reopen permission.",
    });
    throw new Error("This transcript must be reopened by an approver before it can be edited again.");
  }

  const version = priorRevision.version + 1;

  const revision: TranscriptRevision = {
    id: createId("rev"),
    recordingId: recording.id,
    version,
    state: "draft",
    basedOnRevisionId: priorRevision.id,
    createdByRole: params.role,
    createdAt: nowIso(),
    submittedAt: null,
    approvedAt: null,
    summary: params.summary.trim() || "Updated transcript draft.",
    segments: params.segments,
  };

  params.state.revisions.push(revision);
  recording.currentRevisionId = revision.id;
  recording.pendingRevisionId = null;
  recording.updatedAt = nowIso();

  addAuditEvent(params.state, {
    workspaceId: workspace.id,
    recordingId: recording.id,
    actorRole: params.role,
    type: "revision.saved",
    detail: `Draft revision ${version} saved.`,
  });

  return revision;
}

export function submitRevision(params: {
  state: AppState;
  recordingId: string;
  role: UserRole;
  expectedCurrentRevisionId: string;
}) {
  const recording = params.state.recordings.find(
    (entry) => entry.id === params.recordingId,
  );
  if (!recording || !recording.currentRevisionId) {
    throw new Error("No draft is available for submission.");
  }

  const workspace = params.state.workspaces.find(
    (entry) => entry.id === recording.workspaceId,
  );
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const decision = evaluatePolicy(workspace.policyProfileId, params.role);
  if (!decision.canSubmitForApproval) {
    addAuditEvent(params.state, {
      workspaceId: workspace.id,
      recordingId: recording.id,
      actorRole: params.role,
      type: "policy.denied",
      detail: "Approval submission denied by policy.",
    });
    throw new Error("Your role cannot submit transcripts for approval.");
  }

  if (recording.currentRevisionId !== params.expectedCurrentRevisionId) {
    throw new Error("A newer draft revision exists. Reload this recording before submitting it.");
  }

  const revision = params.state.revisions.find(
    (entry) => entry.id === recording.currentRevisionId,
  );
  if (!revision) {
    throw new Error("Draft revision not found.");
  }

  if (revision.state !== "draft") {
    throw new Error("Only draft revisions can be submitted for approval.");
  }

  revision.state = "pending_approval";
  revision.submittedAt = nowIso();
  recording.pendingRevisionId = revision.id;
  recording.updatedAt = nowIso();

  const approval: ApprovalRecord = {
    id: createId("approval"),
    recordingId: recording.id,
    revisionId: revision.id,
    state: "pending",
    actorRole: params.role,
    createdAt: nowIso(),
    note: null,
  };

  params.state.approvals.push(approval);
  addAuditEvent(params.state, {
    workspaceId: workspace.id,
    recordingId: recording.id,
    actorRole: params.role,
    type: "revision.submitted",
    detail: `Revision ${revision.version} submitted for approval.`,
  });
}

export function approveRevision(params: {
  state: AppState;
  recordingId: string;
  role: UserRole;
  expectedPendingRevisionId: string;
}) {
  const recording = params.state.recordings.find(
    (entry) => entry.id === params.recordingId,
  );
  if (!recording || !recording.pendingRevisionId) {
    throw new Error("Nothing is waiting for approval.");
  }

  const workspace = params.state.workspaces.find(
    (entry) => entry.id === recording.workspaceId,
  );
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const decision = evaluatePolicy(workspace.policyProfileId, params.role);
  if (!decision.canApprove) {
    addAuditEvent(params.state, {
      workspaceId: workspace.id,
      recordingId: recording.id,
      actorRole: params.role,
      type: "policy.denied",
      detail: "Approval denied by policy.",
    });
    throw new Error("Your role cannot approve transcripts.");
  }

  if (recording.pendingRevisionId !== params.expectedPendingRevisionId) {
    throw new Error("A different revision is now pending approval. Reload this recording before approving it.");
  }

  const revision = params.state.revisions.find(
    (entry) => entry.id === recording.pendingRevisionId,
  );

  if (!revision) {
    throw new Error("Pending revision not found.");
  }

  revision.state = "approved";
  revision.approvedAt = nowIso();
  recording.approvedRevisionId = revision.id;
  recording.pendingRevisionId = null;
  recording.currentRevisionId = revision.id;
  recording.updatedAt = nowIso();

  params.state.approvals.push({
    id: createId("approval"),
    recordingId: recording.id,
    revisionId: revision.id,
    state: "approved",
    actorRole: params.role,
    createdAt: nowIso(),
    note: "Approved in regulated-mode review flow.",
  });

  addAuditEvent(params.state, {
    workspaceId: workspace.id,
    recordingId: recording.id,
    actorRole: params.role,
    type: "approval.approved",
    detail: `Revision ${revision.version} approved.`,
  });
}

export function reopenApprovedRevision(params: {
  state: AppState;
  recordingId: string;
  role: UserRole;
  expectedApprovedRevisionId: string;
}) {
  const recording = params.state.recordings.find(
    (entry) => entry.id === params.recordingId,
  );

  if (!recording || !recording.approvedRevisionId) {
    throw new Error("No approved revision is available to reopen.");
  }

  const workspace = params.state.workspaces.find(
    (entry) => entry.id === recording.workspaceId,
  );
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const decision = evaluatePolicy(workspace.policyProfileId, params.role);
  if (!decision.canReopenApprovedTranscript) {
    addAuditEvent(params.state, {
      workspaceId: workspace.id,
      recordingId: recording.id,
      actorRole: params.role,
      type: "policy.denied",
      detail: "Reopen denied by policy.",
    });
    throw new Error("Your role cannot reopen approved transcripts.");
  }

  if (recording.approvedRevisionId !== params.expectedApprovedRevisionId) {
    throw new Error("A newer approved revision exists. Reload this recording before reopening it.");
  }

  const approvedRevision = params.state.revisions.find(
    (entry) => entry.id === recording.approvedRevisionId,
  );
  if (!approvedRevision) {
    throw new Error("Approved revision not found.");
  }

  const draft: TranscriptRevision = {
    id: createId("rev"),
    recordingId: recording.id,
    version: approvedRevision.version + 1,
    state: "draft",
    basedOnRevisionId: approvedRevision.id,
    createdByRole: params.role,
    createdAt: nowIso(),
    submittedAt: null,
    approvedAt: null,
    summary: `Reopened from approved revision ${approvedRevision.version}.`,
    segments: cloneSegments(approvedRevision.segments),
  };

  params.state.revisions.push(draft);
  recording.currentRevisionId = draft.id;
  recording.pendingRevisionId = null;
  recording.updatedAt = nowIso();

  params.state.approvals.push({
    id: createId("approval"),
    recordingId: recording.id,
    revisionId: approvedRevision.id,
    state: "reopened",
    actorRole: params.role,
    createdAt: nowIso(),
    note: "Approved revision reopened for a new draft cycle.",
  });

  addAuditEvent(params.state, {
    workspaceId: workspace.id,
    recordingId: recording.id,
    actorRole: params.role,
    type: "approval.reopened",
    detail: `Approved revision ${approvedRevision.version} reopened as draft ${draft.version}.`,
  });
}
