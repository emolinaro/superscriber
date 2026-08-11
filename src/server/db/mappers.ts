import {
  type AppUser,
  type ApprovalRecord,
  type AuditEvent,
  type AuditMetadata,
  type IngestionSession,
  type Recording,
  type RecordingAssignment,
  type TranscriptJob,
  type TranscriptRevision,
} from "@/domain/models";
import {
  type ApprovalRow,
  type AuditEventRow,
  type IngestionSessionRow,
  type RecordingAssignmentRow,
  type RecordingRow,
  type RevisionRow,
  type TranscriptJobRow,
  type UserRow,
} from "@/server/db/schema";

export const EMPTY_AUDIT_METADATA: AuditMetadata = {
  version: 1,
  data: {},
};

export const LEGACY_AUDIT_METADATA: AuditMetadata = {
  version: 1,
  data: {
    legacy: true,
  },
};

function cloneMetadata(metadata: AuditMetadata): AuditMetadata {
  return {
    version: metadata.version,
    data: { ...metadata.data },
  };
}

export function serializeSegments(segments: TranscriptRevision["segments"]) {
  return JSON.stringify(segments);
}

export function deserializeSegments(raw: string) {
  return JSON.parse(raw) as TranscriptRevision["segments"];
}

export function serializeAuditMetadata(metadata: AuditMetadata) {
  return JSON.stringify(metadata);
}

export function deserializeAuditMetadata(raw: string | null | undefined) {
  if (!raw) {
    return cloneMetadata(LEGACY_AUDIT_METADATA);
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AuditMetadata> | null;
    if (
      !parsed ||
      typeof parsed.version !== "number" ||
      !parsed.data ||
      typeof parsed.data !== "object" ||
      Array.isArray(parsed.data)
    ) {
      return cloneMetadata(LEGACY_AUDIT_METADATA);
    }

    return {
      version: parsed.version,
      data: { ...(parsed.data as Record<string, unknown>) },
    };
  } catch {
    return cloneMetadata(LEGACY_AUDIT_METADATA);
  }
}

export function toAppUser(row: UserRow): AppUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRecording(row: RecordingRow): Recording {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    source: row.source,
    mediaKind: row.mediaKind,
    mimeType: row.mimeType,
    mediaPath: row.mediaPath,
    originalFileName: row.originalFileName,
    languageHint: row.languageHint,
    uploadedByRole: row.uploadedByRole,
    uploadedByUserId: row.uploadedByUserId,
    ingestionSessionId: row.ingestionSessionId,
    transcriptJobId: row.transcriptJobId,
    integrityState: row.integrityState,
    transcriptJobState: row.transcriptJobState,
    currentRevisionId: row.currentRevisionId,
    approvedRevisionId: row.approvedRevisionId,
    pendingRevisionId: row.pendingRevisionId,
    verificationSummary: row.verificationSummary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    automationCursor: row.automationCursor,
  };
}

export function toIngestionSession(row: IngestionSessionRow): IngestionSession {
  return {
    id: row.id,
    recordingId: row.recordingId,
    source: row.source,
    state: row.state,
    adapter: row.adapter,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    verifiedAt: row.verifiedAt,
    lastError: row.lastError,
    verificationSummary: row.verificationSummary,
    resumeToken: row.resumeToken,
    bytesReceived: row.bytesReceived,
    bytesExpected: row.bytesExpected,
  };
}

export function toTranscriptJob(row: TranscriptJobRow): TranscriptJob {
  return {
    id: row.id,
    recordingId: row.recordingId,
    state: row.state,
    adapter: row.adapter,
    claimedByWorkerId: row.claimedByWorkerId,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    etaSeconds: row.etaSeconds,
    progressPercent: row.progressPercent,
    transcribedUntilMs: row.transcribedUntilMs,
    audioDurationMs: row.audioDurationMs,
    segmentsSeen: row.segmentsSeen,
    outputRevisionId: row.outputRevisionId,
    lastError: row.lastError,
    diarizationStatus: row.diarizationStatus,
  };
}

export function toRevision(row: RevisionRow): TranscriptRevision {
  return {
    id: row.id,
    recordingId: row.recordingId,
    version: row.version,
    state: row.state,
    basedOnRevisionId: row.basedOnRevisionId,
    createdByRole: row.createdByRole,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    submittedByUserId: row.submittedByUserId,
    submittedAt: row.submittedAt,
    approvedAt: row.approvedAt,
    summary: row.summary,
    segments: deserializeSegments(row.segmentsJson),
  };
}

export function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    recordingId: row.recordingId,
    revisionId: row.revisionId,
    state: row.state,
    actorRole: row.actorRole,
    actorUserId: row.actorUserId,
    actorDisplayName: row.actorDisplayName,
    effectiveRole: row.effectiveRole,
    adminActionSessionId: row.adminActionSessionId,
    createdAt: row.createdAt,
    note: row.note,
  };
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    recordingId: row.recordingId,
    actorRole: row.actorRole,
    actorUserId: row.actorUserId,
    actorDisplayName: row.actorDisplayName,
    effectiveRole: row.effectiveRole,
    adminActionSessionId: row.adminActionSessionId,
    type: row.type,
    detail: row.detail,
    metadata: deserializeAuditMetadata(row.metadata),
    createdAt: row.createdAt,
  };
}

export function toRecordingAssignment(row: RecordingAssignmentRow): RecordingAssignment {
  const status = row.status ?? (row.isActive ? "active" : "removed");

  return {
    id: row.id,
    recordingId: row.recordingId,
    userId: row.userId,
    assignedByUserId: row.assignedByUserId,
    assignmentRole: row.assignmentRole,
    status,
    isActive: status === "active",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
    endReason:
      row.endReason === "legacy_approved_backfill" || row.endReason === "removed_by_admin"
        ? row.endReason
        : null,
    completedRevisionId: row.completedRevisionId,
    removedByUserId: row.removedByUserId,
  };
}
