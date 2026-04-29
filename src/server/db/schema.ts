import { integer, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  APPROVAL_STATES,
  INTEGRITY_STATES,
  JOB_STATES,
  POLICY_PROFILES,
  REVISION_STATES,
  USER_ROLES,
  type ApprovalState,
  type AuditEvent,
  type DiarizationStatus,
  type IntegrityState,
  type MediaKind,
  type PolicyProfileId,
  type RecordingSource,
  type TranscriptJobState,
  type TranscriptRevisionState,
  type UserRole,
} from "@/domain/models";

export const policyProfiles = sqliteTable("policy_profiles", {
  id: text("id", { enum: POLICY_PROFILES }).$type<PolicyProfileId>().primaryKey(),
  label: text("label").notNull(),
  description: text("description").notNull(),
});

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    policyProfileId: text("policy_profile_id", { enum: POLICY_PROFILES })
      .$type<PolicyProfileId>()
      .notNull(),
  },
  (table) => ({
    slugUnique: uniqueIndex("workspaces_slug_unique").on(table.slug),
    policyIdx: index("workspaces_policy_profile_idx").on(table.policyProfileId),
  }),
);

export const recordings = sqliteTable(
  "recordings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    source: text("source").$type<RecordingSource>().notNull(),
    mediaKind: text("media_kind").$type<MediaKind>().notNull(),
    mimeType: text("mime_type"),
    mediaPath: text("media_path"),
    originalFileName: text("original_file_name"),
    languageHint: text("language_hint").notNull(),
    uploadedByRole: text("uploaded_by_role", { enum: USER_ROLES })
      .$type<UserRole>()
      .notNull(),
    ingestionSessionId: text("ingestion_session_id"),
    transcriptJobId: text("transcript_job_id"),
    integrityState: text("integrity_state", { enum: INTEGRITY_STATES })
      .$type<IntegrityState>()
      .notNull(),
    transcriptJobState: text("transcript_job_state", { enum: JOB_STATES })
      .$type<TranscriptJobState>()
      .notNull(),
    currentRevisionId: text("current_revision_id"),
    approvedRevisionId: text("approved_revision_id"),
    pendingRevisionId: text("pending_revision_id"),
    verificationSummary: text("verification_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    automationCursor: text("automation_cursor"),
  },
  (table) => ({
    workspaceUpdatedIdx: index("recordings_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    jobStateIdx: index("recordings_job_state_idx").on(table.transcriptJobState),
    integrityStateIdx: index("recordings_integrity_state_idx").on(table.integrityState),
  }),
);

export const ingestionSessions = sqliteTable(
  "ingestion_sessions",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id").notNull(),
    source: text("source").$type<RecordingSource>().notNull(),
    state: text("state", { enum: INTEGRITY_STATES }).$type<IntegrityState>().notNull(),
    adapter: text("adapter").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    verifiedAt: text("verified_at"),
    lastError: text("last_error"),
    verificationSummary: text("verification_summary"),
    resumeToken: text("resume_token"),
    bytesReceived: integer("bytes_received"),
    bytesExpected: integer("bytes_expected"),
  },
  (table) => ({
    recordingUnique: uniqueIndex("ingestion_sessions_recording_unique").on(table.recordingId),
    stateIdx: index("ingestion_sessions_state_idx").on(table.state),
  }),
);

export const transcriptJobs = sqliteTable(
  "transcript_jobs",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id").notNull(),
    state: text("state", { enum: JOB_STATES }).$type<TranscriptJobState>().notNull(),
    adapter: text("adapter").notNull(),
    claimedByWorkerId: text("claimed_by_worker_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    lastHeartbeatAt: text("last_heartbeat_at"),
    etaSeconds: integer("eta_seconds"),
    progressPercent: integer("progress_percent"),
    outputRevisionId: text("output_revision_id"),
    lastError: text("last_error"),
    diarizationStatus: text("diarization_status").$type<DiarizationStatus>().notNull(),
  },
  (table) => ({
    recordingUnique: uniqueIndex("transcript_jobs_recording_unique").on(table.recordingId),
    stateHeartbeatIdx: index("transcript_jobs_state_heartbeat_idx").on(
      table.state,
      table.lastHeartbeatAt,
    ),
  }),
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id").notNull(),
    version: integer("version").notNull(),
    state: text("state", { enum: REVISION_STATES }).$type<TranscriptRevisionState>().notNull(),
    basedOnRevisionId: text("based_on_revision_id"),
    createdByRole: text("created_by_role").$type<UserRole | "system">().notNull(),
    createdAt: text("created_at").notNull(),
    submittedAt: text("submitted_at"),
    approvedAt: text("approved_at"),
    summary: text("summary").notNull(),
    segmentsJson: text("segments_json").notNull(),
  },
  (table) => ({
    recordingVersionUnique: uniqueIndex("revisions_recording_version_unique").on(
      table.recordingId,
      table.version,
    ),
    recordingStateIdx: index("revisions_recording_state_idx").on(table.recordingId, table.state),
  }),
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id").notNull(),
    revisionId: text("revision_id").notNull(),
    state: text("state", { enum: APPROVAL_STATES }).$type<ApprovalState>().notNull(),
    actorRole: text("actor_role", { enum: USER_ROLES }).$type<UserRole>().notNull(),
    createdAt: text("created_at").notNull(),
    note: text("note"),
  },
  (table) => ({
    recordingCreatedIdx: index("approvals_recording_created_idx").on(
      table.recordingId,
      table.createdAt,
    ),
  }),
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    recordingId: text("recording_id"),
    actorRole: text("actor_role").$type<UserRole | "system">().notNull(),
    type: text("type").$type<AuditEvent["type"]>().notNull(),
    detail: text("detail").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    recordingCreatedIdx: index("audit_events_recording_created_idx").on(
      table.recordingId,
      table.createdAt,
    ),
    workspaceCreatedIdx: index("audit_events_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: USER_ROLES }).$type<UserRole>().notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
    roleIdx: index("users_role_idx").on(table.role),
    activeIdx: index("users_active_idx").on(table.isActive),
  }),
);

export const recordingAssignments = sqliteTable(
  "recording_assignments",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedByUserId: text("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    recordingActiveIdx: index("recording_assignments_recording_active_idx").on(
      table.recordingId,
      table.isActive,
    ),
    userActiveIdx: index("recording_assignments_user_active_idx").on(
      table.userId,
      table.isActive,
    ),
    recordingUserUnique: uniqueIndex("recording_assignments_recording_user_unique").on(
      table.recordingId,
      table.userId,
    ),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type RecordingAssignmentRow = typeof recordingAssignments.$inferSelect;
export type PolicyProfileRow = typeof policyProfiles.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type RecordingRow = typeof recordings.$inferSelect;
export type IngestionSessionRow = typeof ingestionSessions.$inferSelect;
export type TranscriptJobRow = typeof transcriptJobs.$inferSelect;
export type RevisionRow = typeof revisions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
