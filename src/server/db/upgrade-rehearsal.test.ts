import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/server/db/migrations";

/**
 * Slice 8 qualification: every migration stage and the rollback rehearsal run
 * against production-shaped copies (plan sections 11.2 and 11.6). The rollback
 * artifact is the untouched pre-migration backup: it must stay fully readable
 * and be re-migratable to the same invariants.
 */

const NOW = "2026-07-01T00:00:00.000Z";

function seedProductionShapedV2(sqlite: Database.Database) {
  sqlite.exec(`
    INSERT INTO policy_profiles (id, label, description)
      VALUES ('strict', 'Strict regulated mode', 'Strict regulated mode.');
    INSERT INTO workspaces (id, name, slug, policy_profile_id)
      VALUES ('ws-1', 'Workspace', 'workspace', 'strict');
    INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
      VALUES
        ('user-admin', 'admin@example.org', 'Admin', 'hash', 'admin', 1, '${NOW}', '${NOW}'),
        ('user-reviewer', 'reviewer@example.org', 'Reviewer', 'hash', 'reviewer', 1, '${NOW}', '${NOW}'),
        ('user-approver', 'approver@example.org', 'Approver', 'hash', 'approver', 1, '${NOW}', '${NOW}');
    INSERT INTO recordings (
      id, workspace_id, title, source, media_kind, mime_type, media_path,
      original_file_name, language_hint, uploaded_by_role, uploaded_by_user_id,
      ingestion_session_id, transcript_job_id, integrity_state, transcript_job_state,
      current_revision_id, approved_revision_id, pending_revision_id,
      verification_summary, created_at, updated_at, automation_cursor
    ) VALUES (
      'rec-1', 'ws-1', 'Production recording', 'upload', 'audio', 'audio/wav', NULL,
      'rec-1.wav', 'english', 'uploader', NULL,
      'ing-1', 'job-1', 'verified', 'completed',
      'rev-1', 'rev-1', NULL,
      'Verified.', '${NOW}', '${NOW}', NULL
    );
    INSERT INTO ingestion_sessions (
      id, recording_id, source, state, adapter, created_by_user_id, created_at, updated_at
    ) VALUES ('ing-1', 'rec-1', 'upload', 'verified', 'upload', NULL, '${NOW}', '${NOW}');
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
    ) VALUES
      (
        'aud-1', 'ws-1', 'rec-1', 'reviewer', 'user-reviewer', 'Reviewer',
        'reviewer', NULL, 'revision.submitted', 'Submitted.', '{"version":1,"data":{}}', '${NOW}'
      ),
      (
        'aud-2', 'ws-1', 'rec-1', 'approver', 'user-approver', 'Approver',
        'approver', 'aas-1', 'approval.approved', 'Approved.', '{"version":1,"data":{}}', '${NOW}'
      );
    INSERT INTO recording_assignments (
      id, recording_id, user_id, assigned_by_user_id, assignment_role, status,
      is_active, created_at, updated_at
    ) VALUES
      ('asg-1', 'rec-1', 'user-reviewer', 'user-admin', 'reviewer', 'completed', 0, '${NOW}', '${NOW}'),
      ('asg-2', 'rec-1', 'user-approver', 'user-admin', 'approver', 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO admin_action_sessions (
      id, admin_user_id, recording_id, effective_role, purpose, started_at, expires_at, ended_at, end_reason
    ) VALUES (
      'aas-1', 'user-admin', 'rec-1', 'approver', 'Coverage', '${NOW}', '${NOW}', NULL, NULL
    );
  `);
}

function invariants(sqlite: Database.Database) {
  const userIds = (
    sqlite.prepare(`SELECT id FROM users ORDER BY id`).all() as Array<{ id: string }>
  ).map((row) => row.id);
  const referenceCounts: Record<string, number> = {};
  for (const column of [
    "recordings.uploaded_by_user_id",
    "revisions.created_by_user_id",
    "revisions.submitted_by_user_id",
    "approvals.actor_user_id",
    "audit_events.actor_user_id",
    "recording_assignments.user_id",
    "recording_assignments.assigned_by_user_id",
    "admin_action_sessions.admin_user_id",
  ]) {
    const [table, col] = column.split(".");
    referenceCounts[column] = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE "${col}" IS NOT NULL`).get() as {
        c: number;
      }
    ).c;
  }
  const auditCount = (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_events`).get() as { c: number }).c;
  return { userIds, referenceCounts, auditCount };
}

describe("migration rehearsal on production-shaped copies", () => {
  it("stages v2 through v9 preserving every id and reference count; backup stays restorable", () => {
    const production = new Database(":memory:");
    production.pragma("foreign_keys = ON");
    runMigrations(production, 2);
    seedProductionShapedV2(production);
    const before = invariants(production);

    // The rollback artifact: an untouched byte copy of the pre-migration state.
    const backup = Buffer.from(production.serialize());

    // Staged migration, one version at a time, as runbooks describe.
    for (const stage of [3, 4, 5, 6, 7, 8, 9]) {
      runMigrations(production, stage);
      expect(invariants(production)).toEqual(before);
      expect(production.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    }

    // The new auth surfaces exist and the upgrade recorded its one-time event.
    expect(
      production.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE type = 'auth.legacy_sessions_invalidated'`).get(),
    ).toEqual({ c: 1 });
    expect(
      production.prepare(`SELECT auth_version FROM users WHERE id = 'user-admin'`).get(),
    ).toEqual({ auth_version: 1 });

    // Rollback rehearsal: restore the backup; it must be readable at its
    // pre-migration shape and re-migratable to the same invariants.
    const restored = new Database(backup);
    restored.pragma("foreign_keys = ON");
    expect(invariants(restored)).toEqual(before);
    expect(
      restored.prepare(`SELECT COUNT(*) AS c FROM recording_assignments WHERE status = 'active'`).get(),
    ).toEqual({ c: 1 });

    runMigrations(restored);
    expect(invariants(restored)).toEqual(before);
    expect(restored.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(
      restored
        .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
        .all()
        .map((row) => (row as { version: number }).version),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    production.close();
    restored.close();
  });
});
