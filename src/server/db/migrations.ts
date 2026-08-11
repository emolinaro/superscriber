import Database from "better-sqlite3";
import { LEGACY_AUDIT_METADATA, serializeAuditMetadata } from "@/server/db/mappers";

type Migration = {
  version: number;
  name: string;
  up: (sqlite: Database.Database) => void;
  /**
   * SQLite table rebuilds (drop + rename) require PRAGMA foreign_keys = OFF,
   * which is a no-op inside a transaction. The runner toggles it around the
   * migration transaction and verifies foreign_key_check afterwards.
   */
  rebuildsTables?: boolean;
};

export const LATEST_SCHEMA_VERSION = 12;

const migrations: Migration[] = [
  { version: 1, name: "baseline-appliance", up: createBaselineSchema },
  { version: 2, name: "governed-casefile", up: addGovernedCasefileSchema },
  { version: 3, name: "auth-session-registry", up: addAuthSessionRegistrySchema },
  { version: 4, name: "identity-links", up: addIdentityLinksSchema, rebuildsTables: true },
  { version: 5, name: "oidc-backchannel-replays", up: addOidcBackchannelReplaySchema },
  { version: 6, name: "break-glass-controls", up: addBreakGlassControlsSchema },
  { version: 7, name: "break-glass-ceremonies", up: addBreakGlassCeremoniesSchema },
  { version: 8, name: "account-role-guards", up: addAccountRoleGuards },
  { version: 9, name: "user-theme-preference", up: addUserThemePreferenceSchema },
  { version: 10, name: "password-reset-tokens", up: addPasswordResetTokensSchema },
  { version: 11, name: "transcript-job-engine-progress", up: addTranscriptJobEngineProgressSchema },
  { version: 12, name: "transcript-model", up: addTranscriptModelSchema },
];

const LEGACY_AUDIT_METADATA_JSON = serializeAuditMetadata(LEGACY_AUDIT_METADATA);

function nowIso() {
  return new Date().toISOString();
}

function createAuditId() {
  return `audit-migration-${crypto.randomUUID()}`;
}

function tableColumns(sqlite: Database.Database, tableName: string) {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return new Set(rows.map((row) => row.name));
}

function hasColumn(sqlite: Database.Database, tableName: string, columnName: string) {
  return tableColumns(sqlite, tableName).has(columnName);
}

function ensureColumn(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
) {
  if (hasColumn(sqlite, tableName, columnName)) {
    return;
  }

  sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition};`);
}

function hasIndex(sqlite: Database.Database, indexName: string) {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1`,
    )
    .get(indexName);

  return Boolean(row);
}

function hasMigration(sqlite: Database.Database, version: number) {
  const row = sqlite
    .prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1")
    .get(version);

  return Boolean(row);
}

function recordNormalizationAudit(
  sqlite: Database.Database,
  params: {
    workspaceId: string;
    recordingId: string;
    type: "approval.approved" | "approval.reopened";
    detail: string;
    createdAt: string;
  },
) {
  sqlite
    .prepare(
      `
        INSERT INTO audit_events (
          id,
          workspace_id,
          recording_id,
          actor_role,
          actor_user_id,
          actor_display_name,
          effective_role,
          admin_action_session_id,
          type,
          detail,
          metadata,
          created_at
        ) VALUES (?, ?, ?, 'system', NULL, NULL, 'system', NULL, ?, ?, ?, ?)
      `,
    )
    .run(
      createAuditId(),
      params.workspaceId,
      params.recordingId,
      params.type,
      params.detail,
      LEGACY_AUDIT_METADATA_JSON,
      params.createdAt,
    );
}

function createBaselineSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_state_meta (
      id INTEGER PRIMARY KEY NOT NULL,
      state_version INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO app_state_meta (id, state_version) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS policy_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      policy_profile_id TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_unique ON workspaces(slug);
    CREATE INDEX IF NOT EXISTS workspaces_policy_profile_idx
      ON workspaces(policy_profile_id);

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      media_kind TEXT NOT NULL,
      mime_type TEXT,
      media_path TEXT,
      original_file_name TEXT,
      language_hint TEXT NOT NULL,
      uploaded_by_role TEXT NOT NULL,
      ingestion_session_id TEXT,
      transcript_job_id TEXT,
      integrity_state TEXT NOT NULL,
      transcript_job_state TEXT NOT NULL,
      current_revision_id TEXT,
      approved_revision_id TEXT,
      pending_revision_id TEXT,
      verification_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      automation_cursor TEXT
    );

    CREATE INDEX IF NOT EXISTS recordings_workspace_updated_idx
      ON recordings(workspace_id, updated_at);
    CREATE INDEX IF NOT EXISTS recordings_job_state_idx
      ON recordings(transcript_job_state);
    CREATE INDEX IF NOT EXISTS recordings_integrity_state_idx
      ON recordings(integrity_state);

    CREATE TABLE IF NOT EXISTS ingestion_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      recording_id TEXT NOT NULL,
      source TEXT NOT NULL,
      state TEXT NOT NULL,
      adapter TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      verified_at TEXT,
      last_error TEXT,
      verification_summary TEXT,
      resume_token TEXT,
      bytes_received INTEGER,
      bytes_expected INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ingestion_sessions_recording_unique
      ON ingestion_sessions(recording_id);
    CREATE INDEX IF NOT EXISTS ingestion_sessions_state_idx
      ON ingestion_sessions(state);

    CREATE TABLE IF NOT EXISTS transcript_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      recording_id TEXT NOT NULL,
      state TEXT NOT NULL,
      adapter TEXT NOT NULL,
      claimed_by_worker_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      last_heartbeat_at TEXT,
      eta_seconds INTEGER,
      progress_percent INTEGER,
      output_revision_id TEXT,
      last_error TEXT,
      diarization_status TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS transcript_jobs_recording_unique
      ON transcript_jobs(recording_id);
    CREATE INDEX IF NOT EXISTS transcript_jobs_state_heartbeat_idx
      ON transcript_jobs(state, last_heartbeat_at);

    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY NOT NULL,
      recording_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      state TEXT NOT NULL,
      based_on_revision_id TEXT,
      created_by_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      submitted_at TEXT,
      approved_at TEXT,
      summary TEXT NOT NULL,
      segments_json TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS revisions_recording_version_unique
      ON revisions(recording_id, version);
    CREATE INDEX IF NOT EXISTS revisions_recording_state_idx
      ON revisions(recording_id, state);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY NOT NULL,
      recording_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      state TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS approvals_recording_created_idx
      ON approvals(recording_id, created_at);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      recording_id TEXT,
      actor_role TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS audit_events_recording_created_idx
      ON audit_events(recording_id, created_at);
    CREATE INDEX IF NOT EXISTS audit_events_workspace_created_idx
      ON audit_events(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);
    CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
    CREATE INDEX IF NOT EXISTS users_active_idx ON users(is_active);

    CREATE TABLE IF NOT EXISTS recording_assignments (
      id TEXT PRIMARY KEY NOT NULL,
      recording_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assigned_by_user_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(assigned_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS recording_assignments_recording_user_unique
      ON recording_assignments(recording_id, user_id);
    CREATE INDEX IF NOT EXISTS recording_assignments_recording_active_idx
      ON recording_assignments(recording_id, is_active);
    CREATE INDEX IF NOT EXISTS recording_assignments_user_active_idx
      ON recording_assignments(user_id, is_active);
  `);

  ensureColumn(
    sqlite,
    "transcript_jobs",
    "claimed_by_worker_id",
    "claimed_by_worker_id TEXT",
  );
  ensureColumn(
    sqlite,
    "transcript_jobs",
    "attempt_count",
    "attempt_count INTEGER NOT NULL DEFAULT 0",
  );
}

function addGovernedCasefileSchema(sqlite: Database.Database) {
  ensureColumn(
    sqlite,
    "recordings",
    "uploaded_by_user_id",
    "uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  );
  ensureColumn(
    sqlite,
    "ingestion_sessions",
    "created_by_user_id",
    "created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  );
  ensureColumn(
    sqlite,
    "revisions",
    "created_by_user_id",
    "created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  );
  ensureColumn(
    sqlite,
    "revisions",
    "submitted_by_user_id",
    "submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  );
  ensureColumn(
    sqlite,
    "approvals",
    "actor_user_id",
    "actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  );
  ensureColumn(sqlite, "approvals", "actor_display_name", "actor_display_name TEXT");
  ensureColumn(sqlite, "approvals", "effective_role", "effective_role TEXT");
  ensureColumn(
    sqlite,
    "approvals",
    "admin_action_session_id",
    "admin_action_session_id TEXT",
  );
  ensureColumn(
    sqlite,
    "audit_events",
    "actor_user_id",
    "actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  );
  ensureColumn(sqlite, "audit_events", "actor_display_name", "actor_display_name TEXT");
  ensureColumn(sqlite, "audit_events", "effective_role", "effective_role TEXT");
  ensureColumn(
    sqlite,
    "audit_events",
    "admin_action_session_id",
    "admin_action_session_id TEXT",
  );
  ensureColumn(
    sqlite,
    "audit_events",
    "metadata",
    `metadata TEXT NOT NULL DEFAULT '${LEGACY_AUDIT_METADATA_JSON}'`,
  );
  ensureColumn(sqlite, "recording_assignments", "assignment_role", "assignment_role TEXT");
  ensureColumn(
    sqlite,
    "recording_assignments",
    "status",
    "status TEXT NOT NULL DEFAULT 'active'",
  );
  ensureColumn(sqlite, "recording_assignments", "ended_at", "ended_at TEXT");
  ensureColumn(sqlite, "recording_assignments", "end_reason", "end_reason TEXT");
  ensureColumn(
    sqlite,
    "recording_assignments",
    "completed_revision_id",
    "completed_revision_id TEXT REFERENCES revisions(id) ON DELETE SET NULL",
  );
  ensureColumn(
    sqlite,
    "recording_assignments",
    "removed_by_user_id",
    "removed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
  );

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS admin_action_sessions (
      id TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL REFERENCES users(id),
      recording_id TEXT NOT NULL,
      effective_role TEXT NOT NULL,
      purpose TEXT NOT NULL,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    );
  `);

  sqlite
    .prepare(
      `
        UPDATE audit_events
        SET metadata = ?
        WHERE metadata IS NULL OR TRIM(metadata) = ''
      `,
    )
    .run(LEGACY_AUDIT_METADATA_JSON);

  sqlite.exec(`
    UPDATE approvals
    SET effective_role = actor_role
    WHERE effective_role IS NULL;

    UPDATE audit_events
    SET effective_role = actor_role
    WHERE effective_role IS NULL;

    UPDATE recording_assignments
    SET assignment_role = (
      SELECT CASE users.role
        WHEN 'approver' THEN 'approver'
        ELSE 'reviewer'
      END
      FROM users
      WHERE users.id = recording_assignments.user_id
    )
    WHERE assignment_role IS NULL;

    UPDATE recording_assignments
    SET status = CASE
      WHEN is_active = 1 THEN 'active'
      ELSE 'removed'
    END
    WHERE status IS NULL OR TRIM(status) = '';

    UPDATE recording_assignments
    SET ended_at = COALESCE(ended_at, updated_at)
    WHERE status = 'removed' AND ended_at IS NULL;
  `);

  const reopenedRows = sqlite
    .prepare(
      `
        SELECT
          recordings.id AS recordingId,
          recordings.workspace_id AS workspaceId,
          recordings.current_revision_id AS currentRevisionId,
          revisions.state AS currentRevisionState
        FROM recordings
        INNER JOIN revisions ON revisions.id = recordings.current_revision_id
        WHERE recordings.approved_revision_id IS NOT NULL
          AND recordings.current_revision_id IS NOT NULL
          AND recordings.current_revision_id <> recordings.approved_revision_id
          AND revisions.state <> 'approved'
      `,
    )
    .all() as Array<{
    recordingId: string;
    workspaceId: string;
    currentRevisionId: string | null;
    currentRevisionState: string;
  }>;

  for (const row of reopenedRows) {
    sqlite
      .prepare(
        `
          UPDATE recordings
          SET approved_revision_id = NULL,
              pending_revision_id = CASE
                WHEN ? = 'pending_approval' THEN ?
                ELSE NULL
              END
          WHERE id = ?
        `,
      )
      .run(row.currentRevisionState, row.currentRevisionId, row.recordingId);

    recordNormalizationAudit(sqlite, {
      workspaceId: row.workspaceId,
      recordingId: row.recordingId,
      type: "approval.reopened",
      detail: "Governed casefile migration normalized a legacy reopened approval pointer.",
      createdAt: nowIso(),
    });
  }

  const completedRows = sqlite
    .prepare(
      `
        SELECT
          assignments.id AS assignmentId,
          assignments.recording_id AS recordingId,
          recordings.workspace_id AS workspaceId,
          recordings.approved_revision_id AS approvedRevisionId,
          COALESCE(revisions.approved_at, recordings.updated_at, assignments.updated_at) AS endedAt
        FROM recording_assignments AS assignments
        INNER JOIN recordings ON recordings.id = assignments.recording_id
        LEFT JOIN revisions ON revisions.id = recordings.approved_revision_id
        WHERE assignments.status = 'active'
          AND recordings.approved_revision_id IS NOT NULL
          AND recordings.current_revision_id = recordings.approved_revision_id
      `,
    )
    .all() as Array<{
    assignmentId: string;
    recordingId: string;
    workspaceId: string;
    approvedRevisionId: string;
    endedAt: string;
  }>;

  for (const row of completedRows) {
    sqlite
      .prepare(
        `
          UPDATE recording_assignments
          SET status = 'completed',
              is_active = 0,
              ended_at = COALESCE(ended_at, ?),
              end_reason = 'legacy_approved_backfill',
              completed_revision_id = COALESCE(completed_revision_id, ?),
              updated_at = COALESCE(updated_at, ?)
          WHERE id = ?
        `,
      )
      .run(row.endedAt, row.approvedRevisionId, row.endedAt, row.assignmentId);

    recordNormalizationAudit(sqlite, {
      workspaceId: row.workspaceId,
      recordingId: row.recordingId,
      type: "approval.approved",
      detail: "Governed casefile migration completed a legacy active assignment after approval.",
      createdAt: row.endedAt,
    });
  }

  sqlite.exec(`DROP INDEX IF EXISTS recording_assignments_recording_user_unique;`);

  if (!hasIndex(sqlite, "recording_assignments_active_unique")) {
    sqlite.exec(`
      CREATE UNIQUE INDEX recording_assignments_active_unique
      ON recording_assignments(recording_id, user_id, assignment_role)
      WHERE status = 'active';
    `);
  }

  if (!hasIndex(sqlite, "recording_assignments_recording_status_idx")) {
    sqlite.exec(`
      CREATE INDEX recording_assignments_recording_status_idx
      ON recording_assignments(recording_id, status);
    `);
  }

  if (!hasIndex(sqlite, "recording_assignments_user_status_idx")) {
    sqlite.exec(`
      CREATE INDEX recording_assignments_user_status_idx
      ON recording_assignments(user_id, status);
    `);
  }

  if (!hasIndex(sqlite, "admin_action_sessions_open_unique")) {
    sqlite.exec(`
      CREATE UNIQUE INDEX admin_action_sessions_open_unique
      ON admin_action_sessions(admin_user_id, recording_id)
      WHERE ended_at IS NULL;
    `);
  }
}

function addAuthSessionRegistrySchema(sqlite: Database.Database) {
  ensureColumn(sqlite, "users", "auth_version", "auth_version INTEGER NOT NULL DEFAULT 1");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      auth_source TEXT NOT NULL CHECK (auth_source IN ('local', 'authentik', 'break_glass')),
      auth_version INTEGER NOT NULL,
      provider_sid TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      idle_expires_at TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT,
      emergency_activation_id TEXT
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      session_id TEXT,
      correlation_id TEXT,
      source_zone TEXT,
      detail TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{"version":1,"data":{}}',
      created_at TEXT NOT NULL
    );
  `);

  if (!hasIndex(sqlite, "auth_sessions_user_status_idx")) {
    sqlite.exec(`
      CREATE INDEX auth_sessions_user_status_idx
      ON auth_sessions(user_id, status);
    `);
  }

  if (!hasIndex(sqlite, "auth_sessions_provider_sid_idx")) {
    sqlite.exec(`
      CREATE INDEX auth_sessions_provider_sid_idx
      ON auth_sessions(provider_sid);
    `);
  }

  if (!hasIndex(sqlite, "security_events_created_idx")) {
    sqlite.exec(`
      CREATE INDEX security_events_created_idx
      ON security_events(created_at);
    `);
  }

  if (!hasIndex(sqlite, "security_events_user_created_idx")) {
    sqlite.exec(`
      CREATE INDEX security_events_user_created_idx
      ON security_events(user_id, created_at);
    `);
  }

  // When upgrading an appliance that already has users, every pre-existing
  // Auth.js cookie has no auth_sessions row and will be rejected. Record the
  // deployment-level event once instead of enumerating cookie holders.
  const userCount = (
    sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }
  ).count;
  if (userCount > 0) {
    sqlite
      .prepare(
        `
          INSERT INTO security_events (
            id, type, outcome, user_id, session_id, correlation_id, source_zone,
            detail, metadata, created_at
          ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, '{"version":1,"data":{}}', ?)
        `,
      )
      .run(
        `security-migration-${crypto.randomUUID()}`,
        "auth.legacy_sessions_invalidated",
        "success",
        "Session registry introduced; all pre-existing cookie sessions are retired and users must sign in again.",
        nowIso(),
      );
  }
}

function addIdentityLinksSchema(sqlite: Database.Database) {
  // Plan section 4.1: users.password_hash becomes nullable for OIDC-only
  // shadow users via a tested table rebuild. Existing hashes are preserved.
  sqlite.exec(`
    CREATE TABLE users_new (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      auth_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO users_new (
      id, email, display_name, password_hash, role, is_active, auth_version,
      created_at, updated_at
    )
      SELECT id, email, display_name, password_hash, role, is_active, auth_version,
        created_at, updated_at
      FROM users;

    DROP TABLE users;

    ALTER TABLE users_new RENAME TO users;

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);
    CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
    CREATE INDEX IF NOT EXISTS users_active_idx ON users(is_active);

    CREATE TABLE IF NOT EXISTS external_identities (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      linked_at TEXT NOT NULL,
      linked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      retired_at TEXT,
      retired_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      change_reason TEXT NOT NULL,
      last_login_at TEXT,
      last_role_map_version INTEGER
    );
  `);

  if (!hasIndex(sqlite, "external_identity_pair_reserved")) {
    sqlite.exec(`
      CREATE UNIQUE INDEX external_identity_pair_reserved
      ON external_identities(issuer, subject);
    `);
  }

  if (!hasIndex(sqlite, "external_identity_active_user_issuer")) {
    sqlite.exec(`
      CREATE UNIQUE INDEX external_identity_active_user_issuer
      ON external_identities(user_id, issuer)
      WHERE status = 'active';
    `);
  }

  ensureColumn(
    sqlite,
    "auth_sessions",
    "external_identity_id",
    "external_identity_id TEXT REFERENCES external_identities(id) ON DELETE RESTRICT",
  );
}

function addOidcBackchannelReplaySchema(sqlite: Database.Database) {
  // Back-channel logout replay protection (plan 6.4.4): (issuer, jti) pairs
  // are single-use, so retried deliveries are idempotent no-ops.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS oidc_logout_replays (
      id TEXT PRIMARY KEY NOT NULL,
      issuer TEXT NOT NULL,
      jti TEXT NOT NULL,
      seen_at TEXT NOT NULL
    );
  `);

  if (!hasIndex(sqlite, "oidc_logout_replays_issuer_jti_unique")) {
    sqlite.exec(`
      CREATE UNIQUE INDEX oidc_logout_replays_issuer_jti_unique
      ON oidc_logout_replays(issuer, jti);
    `);
  }
}

function addBreakGlassControlsSchema(sqlite: Database.Database) {
  // Plan section 8.1: exactly-one break-glass designation with trigger-level
  // invariants so no service path can bypass them.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS auth_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      break_glass_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      updated_at TEXT NOT NULL,
      updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      change_reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emergency_activations (
      id TEXT PRIMARY KEY NOT NULL,
      correlation_id TEXT NOT NULL UNIQUE,
      break_glass_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      source_zone TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS break_glass_recovery_codes (
      id TEXT PRIMARY KEY NOT NULL,
      break_glass_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      code_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      used_at TEXT,
      rotated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TRIGGER IF NOT EXISTS auth_control_singleton
    BEFORE INSERT ON auth_control
    WHEN (SELECT COUNT(*) FROM auth_control) >= 1
    BEGIN
      SELECT RAISE(ABORT, 'auth_control is a singleton: transfer the existing designation');
    END;

    CREATE TRIGGER IF NOT EXISTS auth_control_must_be_active_admin_insert
    BEFORE INSERT ON auth_control
    WHEN NOT EXISTS (
      SELECT 1 FROM users
      WHERE id = NEW.break_glass_user_id AND role = 'admin' AND is_active = 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'break-glass designation requires an active admin user');
    END;

    CREATE TRIGGER IF NOT EXISTS auth_control_must_be_active_admin_update
    BEFORE UPDATE ON auth_control
    WHEN NOT EXISTS (
      SELECT 1 FROM users
      WHERE id = NEW.break_glass_user_id AND role = 'admin' AND is_active = 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'break-glass designation requires an active admin user');
    END;

    CREATE TRIGGER IF NOT EXISTS users_break_glass_update_guard
    BEFORE UPDATE ON users
    WHEN EXISTS (
      SELECT 1 FROM auth_control WHERE break_glass_user_id = OLD.id
    ) AND (NEW.role != 'admin' OR NEW.is_active != 1)
    BEGIN
      SELECT RAISE(ABORT, 'the designated break-glass user cannot be demoted or deactivated');
    END;

    CREATE TRIGGER IF NOT EXISTS users_break_glass_delete_guard
    BEFORE DELETE ON users
    WHEN EXISTS (
      SELECT 1 FROM auth_control WHERE break_glass_user_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'the designated break-glass user cannot be deleted');
    END;
  `);

  if (!hasIndex(sqlite, "webauthn_credentials_user_idx")) {
    sqlite.exec(`
      CREATE INDEX webauthn_credentials_user_idx
      ON webauthn_credentials(user_id);
    `);
  }
}

function addBreakGlassCeremoniesSchema(sqlite: Database.Database) {
  // One-time emergency ceremony tokens, database-backed so the server-action
  // runtime and the Auth.js callback route share one store.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS break_glass_ceremonies (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      source_zone TEXT NOT NULL,
      via TEXT NOT NULL CHECK (via IN ('webauthn', 'recovery')),
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
  `);

  if (!hasIndex(sqlite, "break_glass_ceremonies_user_idx")) {
    sqlite.exec(`
      CREATE INDEX break_glass_ceremonies_user_idx
      ON break_glass_ceremonies(user_id);
    `);
  }
}

function addAccountRoleGuards(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS users_last_active_admin_role_guard
    BEFORE UPDATE OF role ON users
    WHEN OLD.role = 'admin'
      AND OLD.is_active = 1
      AND NEW.role != 'admin'
      AND NOT EXISTS (
        SELECT 1 FROM users
        WHERE id != OLD.id AND role = 'admin' AND is_active = 1
      )
    BEGIN
      SELECT RAISE(ABORT, 'at least one active administrator must remain');
    END;

    CREATE TRIGGER IF NOT EXISTS users_active_assignment_role_guard
    BEFORE UPDATE OF role ON users
    WHEN EXISTS (
      SELECT 1 FROM recording_assignments
      WHERE user_id = OLD.id
        AND status = 'active'
        AND assignment_role != NEW.role
    )
    BEGIN
      SELECT RAISE(ABORT, 'active assignments must match the user''s role');
    END;

    CREATE TRIGGER IF NOT EXISTS recording_assignments_role_guard_insert
    BEFORE INSERT ON recording_assignments
    WHEN NEW.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = NEW.user_id
          AND role = NEW.assignment_role
          AND role IN ('reviewer', 'approver')
      )
    BEGIN
      SELECT RAISE(ABORT, 'active assignment role must match the assigned user''s role');
    END;

    CREATE TRIGGER IF NOT EXISTS recording_assignments_role_guard_update
    BEFORE UPDATE OF user_id, assignment_role, status ON recording_assignments
    WHEN NEW.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = NEW.user_id
          AND role = NEW.assignment_role
          AND role IN ('reviewer', 'approver')
      )
    BEGIN
      SELECT RAISE(ABORT, 'active assignment role must match the assigned user''s role');
    END;
  `);
}

function addUserThemePreferenceSchema(sqlite: Database.Database) {
  // Per-user appearance preference ("system" | "light" | "dark"). Nullable:
  // no value written yet means the boot copy (localStorage) and the OS
  // setting decide. localStorage stays the no-flash first-paint copy; this
  // row is the durable source of truth synced on session resume.
  ensureColumn(sqlite, "users", "theme_preference", "theme_preference TEXT");
}

function addTranscriptModelSchema(sqlite: Database.Database) {
  // demo-advanced-model-picker: the recording stores the chosen faster-whisper
  // tier (absent = engine default), validated at ingest against provisioned
  // host artifacts and replayed to the worker in the claim payload.
  ensureColumn(sqlite, "recordings", "transcript_model", "transcript_model TEXT");
}

function addPasswordResetTokensSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('self_service', 'admin')),
      delivery TEXT NOT NULL CHECK (delivery IN ('email', 'operator_handoff')),
      requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      invalidated_at TEXT,
      invalidated_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_unique
      ON password_reset_tokens (token_hash);
    CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
      ON password_reset_tokens (user_id);
  `);
}

function addTranscriptJobEngineProgressSchema(sqlite: Database.Database) {
  // Real engine progress samples on transcript jobs: what the worker has
  // transcribed so far, the full audio duration, and how many segments the
  // engine has emitted. Nullable: no engine sample yet means the UI renders a
  // liveness cue instead of a fabricated fill.
  ensureColumn(sqlite, "transcript_jobs", "transcribed_until_ms", "transcribed_until_ms INTEGER");
  ensureColumn(sqlite, "transcript_jobs", "audio_duration_ms", "audio_duration_ms INTEGER");
  ensureColumn(sqlite, "transcript_jobs", "segments_seen", "segments_seen INTEGER");
  sqlite.exec(`
    UPDATE transcript_jobs
    SET progress_percent = NULL
    WHERE state IN ('queued', 'running', 'partial_result');
  `);
}

export function runMigrations(
  sqlite: Database.Database,
  targetVersion = LATEST_SCHEMA_VERSION,
) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of migrations.filter((entry) => entry.version <= targetVersion)) {
    if (hasMigration(sqlite, migration.version)) {
      continue;
    }

    try {
      if (migration.rebuildsTables) {
        sqlite.pragma("foreign_keys = OFF");
      }
      try {
        sqlite.transaction(() => {
          migration.up(sqlite);
          if (migration.rebuildsTables) {
            const violations = sqlite.pragma("foreign_key_check") as unknown[];
            if (violations.length > 0) {
              throw new Error(
                `foreign_key_check reported ${violations.length} violation(s) during migration ${migration.version}.`,
              );
            }
          }
          sqlite
            .prepare(
              "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
            )
            .run(migration.version, migration.name, nowIso());
        })();
      } finally {
        if (migration.rebuildsTables) {
          sqlite.pragma("foreign_keys = ON");
        }
      }
    } catch (error) {
      console.error(error);
      throw new Error(`Database migration ${migration.version} failed.`);
    }
  }
}
