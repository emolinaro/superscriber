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

export const REVISION_STATES = ["draft", "pending_approval", "approved"] as const;
export type TranscriptRevisionState = (typeof REVISION_STATES)[number];

export const APPROVAL_STATES = [
  "not_submitted",
  "pending",
  "approved",
  "rejected",
  "reopened",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const POLICY_PROFILES = ["strict", "reviewable-approved-export"] as const;
export type PolicyProfileId = (typeof POLICY_PROFILES)[number];

export type MediaKind = "audio" | "video";
export type RecordingSource = "upload" | "record";
export type DiarizationStatus = "pending" | "available" | "degraded" | "failed";

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
  createdAt: string;
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
  createdAt: string;
  note: string | null;
};

export type AuditEvent = {
  id: string;
  workspaceId: string;
  recordingId: string | null;
  actorRole: UserRole | "system";
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
    | "approval.approved"
    | "approval.reopened"
    | "policy.denied";
  detail: string;
  createdAt: string;
};

export type RecordingAssignment = {
  id: string;
  recordingId: string;
  userId: string;
  assignedByUserId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
