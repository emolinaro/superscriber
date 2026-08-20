import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  APPROVAL_STATES,
  ASSIGNMENT_STATUSES,
  INTEGRITY_STATES,
  JOB_STATES,
  POLICY_PROFILES,
  REVISION_STATES,
  USER_ROLES,
  type AdminActionSession,
  type ApprovalRecord,
  type AssignmentRole,
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

export const appStateMeta = sqliteTable("app_state_meta", {
  id: integer("id").primaryKey(),
  stateVersion: integer("state_version").notNull(),
});

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
});

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

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    // Nullable since schema v4: OIDC-only shadow users carry no local secret.
    passwordHash: text("password_hash"),
    role: text("role", { enum: USER_ROLES }).$type<UserRole>().notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    // Appearance preference; the localStorage boot copy handles first paint,
    // this row is the per-user durable sync across devices.
    themePreference: text("theme_preference", {
      enum: ["system", "light", "dark"],
    }),
    authVersion: integer("auth_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
    roleIdx: index("users_role_idx").on(table.role),
    activeIdx: index("users_active_idx").on(table.isActive),
  }),
);

export const AUTH_SOURCES = ["local", "authentik", "break_glass"] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

export const AUTH_SESSION_STATUSES = ["active", "revoked", "expired"] as const;
export type AuthSessionStatus = (typeof AUTH_SESSION_STATUSES)[number];

export const SECURITY_EVENT_OUTCOMES = ["success", "denied", "error"] as const;
export type SecurityEventOutcome = (typeof SECURITY_EVENT_OUTCOMES)[number];

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authSource: text("auth_source", { enum: AUTH_SOURCES }).$type<AuthSource>().notNull(),
    authVersion: integer("auth_version").notNull(),
    providerSid: text("provider_sid"),
    externalIdentityId: text("external_identity_id").references(
      () => externalIdentities.id,
      { onDelete: "restrict" },
    ),
    status: text("status", { enum: AUTH_SESSION_STATUSES })
      .$type<AuthSessionStatus>()
      .notNull(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    idleExpiresAt: text("idle_expires_at").notNull(),
    absoluteExpiresAt: text("absolute_expires_at").notNull(),
    revokedAt: text("revoked_at"),
    revokedReason: text("revoked_reason"),
    emergencyActivationId: text("emergency_activation_id"),
  },
  (table) => ({
    userStatusIdx: index("auth_sessions_user_status_idx").on(table.userId, table.status),
    providerSidIdx: index("auth_sessions_provider_sid_idx").on(table.providerSid),
  }),
);

export const EXTERNAL_IDENTITY_STATUSES = ["active", "retired"] as const;
export type ExternalIdentityStatus = (typeof EXTERNAL_IDENTITY_STATUSES)[number];

export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    status: text("status", { enum: EXTERNAL_IDENTITY_STATUSES })
      .$type<ExternalIdentityStatus>()
      .notNull(),
    linkedAt: text("linked_at").notNull(),
    linkedByUserId: text("linked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    retiredAt: text("retired_at"),
    retiredByUserId: text("retired_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    changeReason: text("change_reason").notNull(),
    lastLoginAt: text("last_login_at"),
    lastRoleMapVersion: integer("last_role_map_version"),
  },
  (table) => ({
    pairReservedUnique: uniqueIndex("external_identity_pair_reserved").on(
      table.issuer,
      table.subject,
    ),
    activeUserIssuerUnique: uniqueIndex("external_identity_active_user_issuer")
      .on(table.userId, table.issuer)
      .where(sql`status = 'active'`),
  }),
);

export const authControl = sqliteTable("auth_control", {
  id: integer("id").primaryKey(),
  breakGlassUserId: text("break_glass_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  updatedAt: text("updated_at").notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  changeReason: text("change_reason").notNull(),
});

export const emergencyActivations = sqliteTable(
  "emergency_activations",
  {
    id: text("id").primaryKey(),
    correlationId: text("correlation_id").notNull(),
    breakGlassUserId: text("break_glass_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    sourceZone: text("source_zone").notNull(),
    openedAt: text("opened_at").notNull(),
    endsAt: text("ends_at").notNull(),
    closedAt: text("closed_at"),
  },
  (table) => ({
    correlationUnique: uniqueIndex("emergency_activations_correlation_unique").on(
      table.correlationId,
    ),
  }),
);

export const breakGlassRecoveryCodes = sqliteTable("break_glass_recovery_codes", {
  id: text("id").primaryKey(),
  breakGlassUserId: text("break_glass_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  codeHash: text("code_hash").notNull(),
  createdAt: text("created_at").notNull(),
  usedAt: text("used_at"),
  rotatedAt: text("rotated_at"),
});

export const PASSWORD_RESET_TOKEN_SOURCES = ["self_service", "admin"] as const;
export type PasswordResetTokenSource = (typeof PASSWORD_RESET_TOKEN_SOURCES)[number];

export const PASSWORD_RESET_TOKEN_DELIVERIES = ["email", "operator_handoff"] as const;
export type PasswordResetTokenDelivery = (typeof PASSWORD_RESET_TOKEN_DELIVERIES)[number];

export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    source: text("source", { enum: PASSWORD_RESET_TOKEN_SOURCES })
      .$type<PasswordResetTokenSource>()
      .notNull(),
    delivery: text("delivery", { enum: PASSWORD_RESET_TOKEN_DELIVERIES })
      .$type<PasswordResetTokenDelivery>()
      .notNull(),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    invalidatedAt: text("invalidated_at"),
    invalidatedReason: text("invalidated_reason"),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("password_reset_tokens_hash_unique").on(table.tokenHash),
    userIdx: index("password_reset_tokens_user_idx").on(table.userId),
  }),
);

export const breakGlassCeremonies = sqliteTable(
  "break_glass_ceremonies",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    sourceZone: text("source_zone").notNull(),
    via: text("via", { enum: ["webauthn", "recovery"] }).notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (table) => ({
    userIdx: index("break_glass_ceremonies_user_idx").on(table.userId),
  }),
);

export const webauthnCredentials = sqliteTable(
  "webauthn_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports"),
    label: text("label").notNull().default(""),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (table) => ({
    userIdx: index("webauthn_credentials_user_idx").on(table.userId),
  }),
);

export const oidcLogoutReplays = sqliteTable(
  "oidc_logout_replays",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    jti: text("jti").notNull(),
    seenAt: text("seen_at").notNull(),
  },
  (table) => ({
    issuerJtiUnique: uniqueIndex("oidc_logout_replays_issuer_jti_unique").on(
      table.issuer,
      table.jti,
    ),
  }),
);

export const securityEvents = sqliteTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    outcome: text("outcome", { enum: SECURITY_EVENT_OUTCOMES })
      .$type<SecurityEventOutcome>()
      .notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id"),
    correlationId: text("correlation_id"),
    sourceZone: text("source_zone"),
    detail: text("detail").notNull().default(""),
    metadata: text("metadata").notNull().default('{"version":1,"data":{}}'),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    createdIdx: index("security_events_created_idx").on(table.createdAt),
    userCreatedIdx: index("security_events_user_created_idx").on(table.userId, table.createdAt),
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
    // demo-advanced-model-picker: the faster-whisper tier chosen at ingest;
    // null means the worker's configured default.
    transcriptModel: text("transcript_model"),
    uploadedByRole: text("uploaded_by_role", { enum: USER_ROLES })
      .$type<UserRole>()
      .notNull(),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    // Real engine samples (faster-whisper emits per-segment timestamps) -
    // never synthesized. Null until a real sample arrives; the UI shows
    // liveness cues instead of a fake bar.
    transcribedUntilMs: integer("transcribed_until_ms"),
    audioDurationMs: integer("audio_duration_ms"),
    segmentsSeen: integer("segments_seen"),
    outputRevisionId: text("output_revision_id"),
    lastError: text("last_error"),
    lastErrorKind: text("last_error_kind"),
    lastErrorTechnical: text("last_error_technical"),
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
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    submittedByUserId: text("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorDisplayName: text("actor_display_name"),
    effectiveRole: text("effective_role").$type<ApprovalRecord["effectiveRole"]>(),
    adminActionSessionId: text("admin_action_session_id"),
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
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorDisplayName: text("actor_display_name"),
    effectiveRole: text("effective_role").$type<AuditEvent["effectiveRole"]>(),
    adminActionSessionId: text("admin_action_session_id"),
    type: text("type").$type<AuditEvent["type"]>().notNull(),
    detail: text("detail").notNull(),
    metadata: text("metadata").notNull(),
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
    assignmentRole: text("assignment_role").$type<AssignmentRole>().notNull(),
    status: text("status", { enum: ASSIGNMENT_STATUSES }).notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    endedAt: text("ended_at"),
    endReason: text("end_reason"),
    completedRevisionId: text("completed_revision_id").references(() => revisions.id, {
      onDelete: "set null",
    }),
    removedByUserId: text("removed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    recordingStatusIdx: index("recording_assignments_recording_status_idx").on(
      table.recordingId,
      table.status,
    ),
    userStatusIdx: index("recording_assignments_user_status_idx").on(
      table.userId,
      table.status,
    ),
  }),
);

export const adminActionSessions = sqliteTable(
  "admin_action_sessions",
  {
    id: text("id").primaryKey(),
    adminUserId: text("admin_user_id")
      .notNull()
      .references(() => users.id),
    recordingId: text("recording_id").notNull(),
    effectiveRole: text("effective_role").$type<AdminActionSession["effectiveRole"]>().notNull(),
    purpose: text("purpose").notNull(),
    startedAt: text("started_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    endedAt: text("ended_at"),
    endReason: text("end_reason").$type<AdminActionSession["endReason"]>(),
  },
  (table) => ({
    recordingIdx: index("admin_action_sessions_recording_idx").on(table.recordingId),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type AppStateMetaRow = typeof appStateMeta.$inferSelect;
export type SchemaMigrationRow = typeof schemaMigrations.$inferSelect;
export type RecordingAssignmentRow = typeof recordingAssignments.$inferSelect;
export type PolicyProfileRow = typeof policyProfiles.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type RecordingRow = typeof recordings.$inferSelect;
export type IngestionSessionRow = typeof ingestionSessions.$inferSelect;
export type TranscriptJobRow = typeof transcriptJobs.$inferSelect;
export type RevisionRow = typeof revisions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type AdminActionSessionRow = typeof adminActionSessions.$inferSelect;
