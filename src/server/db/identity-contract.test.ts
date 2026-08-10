import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/server/db/migrations";

/**
 * Slice 0 contract inventory for the Authentik identity integration.
 *
 * The approved plan (report section 4, invariant 10) requires every local
 * `users.id` value and every governed reference to survive the identity
 * integration unchanged. This suite pins down the exact set of columns that
 * reference `users(id)`, proves a seeded appliance database has no orphan
 * references, and proves a binary copy re-migrated at the latest schema
 * preserves all user IDs and reference counts exactly.
 *
 * Adding, renaming, or removing a user reference in a future migration must
 * intentionally update EXPECTED_USER_REFERENCES below.
 */

const EXPECTED_USER_REFERENCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: "admin_action_sessions", column: "admin_user_id" },
  { table: "approvals", column: "actor_user_id" },
  { table: "audit_events", column: "actor_user_id" },
  { table: "auth_control", column: "break_glass_user_id" },
  { table: "auth_control", column: "updated_by_user_id" },
  { table: "auth_sessions", column: "user_id" },
  { table: "password_reset_tokens", column: "requested_by_user_id" },
  { table: "password_reset_tokens", column: "user_id" },
  { table: "break_glass_ceremonies", column: "user_id" },
  { table: "break_glass_recovery_codes", column: "break_glass_user_id" },
  { table: "emergency_activations", column: "break_glass_user_id" },
  { table: "external_identities", column: "linked_by_user_id" },
  { table: "external_identities", column: "retired_by_user_id" },
  { table: "external_identities", column: "user_id" },
  { table: "ingestion_sessions", column: "created_by_user_id" },
  { table: "security_events", column: "user_id" },
  { table: "webauthn_credentials", column: "user_id" },
  { table: "recording_assignments", column: "assigned_by_user_id" },
  { table: "recording_assignments", column: "removed_by_user_id" },
  { table: "recording_assignments", column: "user_id" },
  { table: "recordings", column: "uploaded_by_user_id" },
  { table: "revisions", column: "created_by_user_id" },
  { table: "revisions", column: "submitted_by_user_id" },
];

function sortReferences(references: ReadonlyArray<{ table: string; column: string }>) {
  return [...references].sort((a, b) =>
    a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table),
  );
}

const NOW = "2026-08-03T00:00:00.000Z";

function listUserReferences(sqlite: Database.Database) {
  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  const references: Array<{ table: string; column: string }> = [];
  for (const { name } of tables) {
    const fks = sqlite
      .prepare(`SELECT "from" AS columnName, "table" AS refTable FROM pragma_foreign_key_list(?)`)
      .all(name) as Array<{ columnName: string; refTable: string }>;

    for (const fk of fks) {
      if (fk.refTable === "users") {
        references.push({ table: name, column: fk.columnName });
      }
    }
  }

  return references.sort((a, b) =>
    a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table),
  );
}

function referenceCounts(sqlite: Database.Database) {
  const counts: Record<string, number> = {};
  for (const { table, column } of EXPECTED_USER_REFERENCES) {
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE "${column}" IS NOT NULL`)
      .get() as { count: number };
    counts[`${table}.${column}`] = row.count;
  }
  return counts;
}

function userIds(sqlite: Database.Database) {
  const rows = sqlite.prepare(`SELECT id FROM users ORDER BY id`).all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function seedGovernedFixture(sqlite: Database.Database) {
  sqlite.exec(`
    INSERT INTO policy_profiles (id, label, description)
      VALUES ('strict', 'Strict regulated mode', 'Strict regulated mode.');
    INSERT INTO workspaces (id, name, slug, policy_profile_id)
      VALUES ('ws-1', 'Workspace', 'workspace', 'strict');
    INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
      VALUES
        ('user-admin', 'admin@example.com', 'Admin', 'hash', 'admin', 1, '${NOW}', '${NOW}'),
        ('user-reviewer', 'reviewer@example.com', 'Reviewer', 'hash', 'reviewer', 1, '${NOW}', '${NOW}'),
        ('user-approver', 'approver@example.com', 'Approver', 'hash', 'approver', 1, '${NOW}', '${NOW}'),
        ('user-uploader', 'uploader@example.com', 'Uploader', 'hash', 'uploader', 1, '${NOW}', '${NOW}');
    INSERT INTO recordings (
      id, workspace_id, title, source, media_kind, mime_type, media_path,
      original_file_name, language_hint, uploaded_by_role, uploaded_by_user_id,
      ingestion_session_id, transcript_job_id, integrity_state, transcript_job_state,
      current_revision_id, approved_revision_id, pending_revision_id,
      verification_summary, created_at, updated_at, automation_cursor
    ) VALUES (
      'rec-1', 'ws-1', 'Recording', 'upload', 'audio', 'audio/wav', NULL,
      'rec-1.wav', 'english', 'uploader', 'user-uploader',
      'ing-1', 'job-1', 'verified', 'completed',
      'rev-1', 'rev-1', NULL,
      'Verified.', '${NOW}', '${NOW}', NULL
    );
    INSERT INTO ingestion_sessions (
      id, recording_id, source, state, adapter, created_by_user_id, created_at, updated_at
    ) VALUES ('ing-1', 'rec-1', 'upload', 'verified', 'upload', 'user-uploader', '${NOW}', '${NOW}');
    INSERT INTO transcript_jobs (
      id, recording_id, state, adapter, created_at, updated_at, diarization_status
    ) VALUES ('job-1', 'rec-1', 'completed', 'stub', '${NOW}', '${NOW}', 'available');
    INSERT INTO revisions (
      id, recording_id, version, state, based_on_revision_id, created_by_role,
      created_by_user_id, submitted_by_user_id, created_at, submitted_at, approved_at,
      summary, segments_json
    ) VALUES (
      'rev-1', 'rec-1', 1, 'approved', NULL, 'reviewer',
      'user-reviewer', 'user-reviewer', '${NOW}', '${NOW}', '${NOW}',
      'Revision', '[]'
    );
    INSERT INTO approvals (
      id, recording_id, revision_id, state, actor_role, actor_user_id,
      actor_display_name, effective_role, admin_action_session_id, created_at, note
    ) VALUES (
      'app-1', 'rec-1', 'rev-1', 'approved', 'approver', 'user-approver',
      'Approver', 'approver', 'aas-1', '${NOW}', NULL
    );
    INSERT INTO audit_events (
      id, workspace_id, recording_id, actor_role, actor_user_id, actor_display_name,
      effective_role, admin_action_session_id, type, detail, metadata, created_at
    ) VALUES (
      'aud-1', 'ws-1', 'rec-1', 'approver', 'user-approver', 'Approver',
      'approver', 'aas-1', 'approval.approved', 'Approved.', '{"version":1,"data":{}}', '${NOW}'
    );
    INSERT INTO recording_assignments (
      id, recording_id, user_id, assigned_by_user_id, assignment_role, status,
      is_active, created_at, updated_at
    ) VALUES
      ('asg-1', 'rec-1', 'user-reviewer', 'user-admin', 'reviewer', 'completed', 0, '${NOW}', '${NOW}'),
      ('asg-2', 'rec-1', 'user-approver', 'user-admin', 'approver', 'removed', 0, '${NOW}', '${NOW}');
    UPDATE recording_assignments
      SET ended_at = '${NOW}', end_reason = 'removed_by_admin', removed_by_user_id = 'user-admin'
      WHERE id = 'asg-2';
    INSERT INTO admin_action_sessions (
      id, admin_user_id, recording_id, effective_role, purpose, started_at, expires_at
    ) VALUES (
      'aas-1', 'user-admin', 'rec-1', 'approver', 'Contract inventory fixture', '${NOW}', '${NOW}'
    );
  `);
}

describe("identity contract inventory", () => {
  it("matches the expected set of user-reference columns exactly", () => {
    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite);
      expect(listUserReferences(sqlite)).toEqual(sortReferences(EXPECTED_USER_REFERENCES));
    } finally {
      sqlite.close();
    }
  });

  it("seeds exact user-reference counts with no orphan references", () => {
    const sqlite = new Database(":memory:");
    try {
      runMigrations(sqlite);
      seedGovernedFixture(sqlite);

      expect(referenceCounts(sqlite)).toEqual({
        "admin_action_sessions.admin_user_id": 1,
        "approvals.actor_user_id": 1,
        "audit_events.actor_user_id": 1,
        "auth_control.break_glass_user_id": 0,
        "auth_control.updated_by_user_id": 0,
        "auth_sessions.user_id": 0,
        "break_glass_ceremonies.user_id": 0,
        "break_glass_recovery_codes.break_glass_user_id": 0,
        "emergency_activations.break_glass_user_id": 0,
        "external_identities.linked_by_user_id": 0,
        "external_identities.retired_by_user_id": 0,
        "external_identities.user_id": 0,
        "ingestion_sessions.created_by_user_id": 1,
        "password_reset_tokens.requested_by_user_id": 0,
        "password_reset_tokens.user_id": 0,
        "security_events.user_id": 0,
        "webauthn_credentials.user_id": 0,
        "recordings.uploaded_by_user_id": 1,
        "recording_assignments.assigned_by_user_id": 2,
        "recording_assignments.removed_by_user_id": 1,
        "recording_assignments.user_id": 2,
        "revisions.created_by_user_id": 1,
        "revisions.submitted_by_user_id": 1,
      });

      const orphans = sqlite.prepare(`PRAGMA foreign_key_check`).all();
      expect(orphans).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("preserves every user id and reference count across a database copy and migration rerun", () => {
    const source = new Database(":memory:");
    try {
      runMigrations(source);
      source.pragma("foreign_keys = ON");
      seedGovernedFixture(source);

      const copy = new Database(source.serialize());
      try {
        copy.pragma("foreign_keys = ON");

        // Migration rerun on the copy must be a no-op: versions are recorded.
        const before = copy
          .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
          .all();
        runMigrations(copy);
        const after = copy
          .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
          .all();
        expect(after).toEqual(before);

        expect(userIds(copy)).toEqual(userIds(source));
        expect(referenceCounts(copy)).toEqual(referenceCounts(source));
        expect(copy.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
      } finally {
        copy.close();
      }
    } finally {
      source.close();
    }
  });
});
