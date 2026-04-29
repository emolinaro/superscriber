import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/server/db/schema";

const DEFAULT_DATABASE_PATH = join(process.cwd(), "data", "superscriber.db");

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export type AppDatabaseBundle = {
  sqlite: Database.Database;
  db: AppDatabase;
};

let defaultBundle: AppDatabaseBundle | null = null;

function resolveDatabasePath() {
  return process.env.SUPERSCRIBER_DB_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

function tableColumns(sqlite: Database.Database, tableName: string) {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return new Set(rows.map((row) => row.name));
}

function ensureColumn(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = tableColumns(sqlite, tableName);
  if (columns.has(columnName)) {
    return;
  }

  sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition};`);
}

function ensureSchema(sqlite: Database.Database) {
  sqlite.exec(`
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

export function openAppDatabase(path = resolveDatabasePath()): AppDatabaseBundle {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  ensureSchema(sqlite);

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
  };
}

export function getAppDb() {
  if (!defaultBundle) {
    defaultBundle = openAppDatabase();
  }

  return defaultBundle.db;
}

export function getAppDbBundle() {
  if (!defaultBundle) {
    defaultBundle = openAppDatabase();
  }

  return defaultBundle;
}

export function resetAppDatabaseForTests() {
  if (!defaultBundle) {
    return;
  }

  defaultBundle.sqlite.close();
  defaultBundle = null;
}
