export const USER_ROLES = ["uploader", "reviewer", "approver", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const INTEGRITY_STATES = [
  "capturing",
  "uploading",
  "verifying",
  "verified",
  "verification_failed",
  "interrupted",
] as const;
export type IntegrityState = (typeof INTEGRITY_STATES)[number];

export const JOB_STATES = [
  "queued",
  "running",
  "partial_result",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TranscriptJobState = (typeof JOB_STATES)[number];

export const REVISION_STATES = [
  "draft",
  "pending_approval",
  "approved",
  "superseded",
  "withdrawn",
  "changes_requested",
] as const;
export type TranscriptRevisionState = (typeof REVISION_STATES)[number];

export const APPROVAL_STATES = [
  "not_submitted",
  "pending",
  "approved",
  "rejected",
  "reopened",
  "withdrawn",
  "changes_requested",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const ASSIGNMENT_STATUSES = ["active", "completed", "removed"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ADMIN_ACTION_END_REASONS = ["exited", "expired", "switched"] as const;
export type AdminActionEndReason = (typeof ADMIN_ACTION_END_REASONS)[number];

export const POLICY_PROFILES = ["strict", "reviewable-approved-export"] as const;
export type PolicyProfileId = (typeof POLICY_PROFILES)[number];

export type MediaKind = "audio" | "video";
export type RecordingSource = "upload" | "record";
export type DiarizationStatus = "pending" | "available" | "degraded" | "failed";
export type AssignmentRole = Extract<UserRole, "reviewer" | "approver">;
export type AssignmentEndReason = "removed_by_admin" | "legacy_approved_backfill";

export type AuditMetadata = {
  version: number;
  data: Record<string, unknown>;
};

export type TranscriptSegment = {
  id: string;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
};

export type PolicyProfile = {
  id: PolicyProfileId;
  label: string;
  description: string;
};

export type AppUser = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Principal = {
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
};

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  policyProfileId: PolicyProfileId;
};

export type Recording = {
  id: string;
  workspaceId: string;
  title: string;
  source: RecordingSource;
  mediaKind: MediaKind;
  mimeType: string | null;
  mediaPath: string | null;
  originalFileName: string | null;
  languageHint: string;
  uploadedByRole: UserRole;
  uploadedByUserId: string | null;
  ingestionSessionId: string | null;
  transcriptJobId: string | null;
  integrityState: IntegrityState;
  transcriptJobState: TranscriptJobState;
  currentRevisionId: string | null;
  approvedRevisionId: string | null;
  pendingRevisionId: string | null;
  verificationSummary: string | null;
  createdAt: string;
  updatedAt: string;
  automationCursor: string | null;
};

export type IngestionSession = {
  id: string;
  recordingId: string;
  source: RecordingSource;
  state: IntegrityState;
  adapter: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  verificationSummary: string | null;
  resumeToken: string | null;
  bytesReceived: number | null;
  bytesExpected: number | null;
};

export type TranscriptJob = {
  id: string;
  recordingId: string;
  state: TranscriptJobState;
  adapter: string;
  claimedByWorkerId: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeatAt: string | null;
  etaSeconds: number | null;
  progressPercent: number | null;
  /** Real engine samples (nullable until the first engine segment lands);
     percent is derived from these, never synthesized by the app. */
  transcribedUntilMs: number | null;
  audioDurationMs: number | null;
  segmentsSeen: number | null;
  outputRevisionId: string | null;
  lastError: string | null;
  diarizationStatus: DiarizationStatus;
};

export type TranscriptRevision = {
  id: string;
  recordingId: string;
  version: number;
  state: TranscriptRevisionState;
  basedOnRevisionId: string | null;
  createdByRole: UserRole | "system";
  createdByUserId: string | null;
  createdAt: string;
  submittedByUserId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  summary: string;
  segments: TranscriptSegment[];
};

export type ApprovalRecord = {
  id: string;
  recordingId: string;
  revisionId: string;
  state: ApprovalState;
  actorRole: UserRole;
  actorUserId: string | null;
  actorDisplayName: string | null;
  effectiveRole: UserRole | null;
  adminActionSessionId: string | null;
  createdAt: string;
  note: string | null;
};

export type AuditEvent = {
  id: string;
  workspaceId: string;
  recordingId: string | null;
  actorRole: UserRole | "system";
  actorUserId: string | null;
  actorDisplayName: string | null;
  effectiveRole: UserRole | "system" | null;
  adminActionSessionId: string | null;
  type:
    | "session.started"
    | "recording.created"
    | "recording.verified"
    | "recording.verification_failed"
    | "transcription.started"
    | "transcription.partial"
    | "transcription.completed"
    | "transcription.failed"
    | "revision.saved"
    | "revision.submitted"
    | "revision.withdrawn"
    | "approval.approved"
    | "approval.changes_requested"
    | "approval.reopened"
    | "assignment.created"
    | "assignment.completed"
    | "assignment.removed"
    | "account.role_changed"
    | "account.password_reset"
    | "admin.action_mode.entered"
    | "admin.action_mode.exited"
    | "export.issued"
    | "policy.denied"
    | "revision.recovered";
  detail: string;
  metadata: AuditMetadata;
  createdAt: string;
};

export type RecordingAssignment = {
  id: string;
  recordingId: string;
  userId: string;
  assignedByUserId: string | null;
  assignmentRole: AssignmentRole;
  status: AssignmentStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  endReason: AssignmentEndReason | null;
  completedRevisionId: string | null;
  removedByUserId: string | null;
};

export type AdminActionSession = {
  id: string;
  adminUserId: string;
  recordingId: string;
  effectiveRole: "reviewer" | "approver";
  purpose: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: AdminActionEndReason | null;
};

export type AppState = {
  workspaces: Workspace[];
  policyProfiles: PolicyProfile[];
  recordings: Recording[];
  ingestionSessions: IngestionSession[];
  transcriptJobs: TranscriptJob[];
  revisions: TranscriptRevision[];
  approvals: ApprovalRecord[];
  auditEvents: AuditEvent[];
};

export type PolicyDecision = {
  canViewMedia: boolean;
  canDownloadRawMedia: boolean;
  canEditDraft: boolean;
  canSubmitForApproval: boolean;
  canApprove: boolean;
  canDownloadApprovedTranscript: boolean;
  canReopenApprovedTranscript: boolean;
};

export type WorkspaceBucket =
  | "needs_ingest"
  | "verifying"
  | "transcribing"
  | "needs_review"
  | "pending_approval"
  | "approved";
