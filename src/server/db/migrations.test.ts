import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "@/server/db/migrations";

type LegacyFixtureOptions = {
  approvedWithActiveAssignments?: boolean;
  approvedPointerWithDifferentDraft?: boolean;
};

function seedCurrentSchemaFixture(
  sqlite: Database.Database,
  options: LegacyFixtureOptions = {},
) {
  const now = "2026-08-01T00:00:00.000Z";

  sqlite.exec(`
    INSERT OR IGNORE INTO app_state_meta (id, state_version) VALUES (1, 0);
    INSERT INTO policy_profiles (id, label, description)
      VALUES ('strict', 'Strict regulated mode', 'Strict regulated mode.');
    INSERT INTO workspaces (id, name, slug, policy_profile_id)
      VALUES ('workspace-1', 'Workspace', 'workspace', 'strict');
    INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
      VALUES
        ('user-reviewer', 'reviewer@example.com', 'Reviewer', 'hash', 'reviewer', 1, '${now}', '${now}'),
        ('user-approver', 'approver@example.com', 'Approver', 'hash', 'approver', 1, '${now}', '${now}');
  `);

  if (options.approvedWithActiveAssignments) {
    sqlite.exec(`
      INSERT INTO recordings (
        id, workspace_id, title, source, media_kind, mime_type, media_path,
        original_file_name, language_hint, uploaded_by_role, ingestion_session_id,
        transcript_job_id, integrity_state, transcript_job_state, current_revision_id,
        approved_revision_id, pending_revision_id, verification_summary, created_at,
        updated_at, automation_cursor
      ) VALUES (
        'legacy-approved', 'workspace-1', 'Legacy approved', 'upload', 'audio',
        'audio/wav', NULL, 'legacy-approved.wav', 'english', 'uploader', NULL, NULL,
        'verified', 'completed', 'legacy-approved-rev', 'legacy-approved-rev', NULL,
        'Approved legacy row.', '${now}', '${now}', NULL
      );

      INSERT INTO revisions (
        id, recording_id, version, state, based_on_revision_id, created_by_role,
        created_at, submitted_at, approved_at, summary, segments_json
      ) VALUES (
        'legacy-approved-rev', 'legacy-approved', 1, 'approved', NULL, 'reviewer',
        '${now}', '${now}', '${now}', 'Legacy approved revision', '[]'
      );

      INSERT INTO recording_assignments (
        id, recording_id, user_id, assigned_by_user_id, is_active, created_at, updated_at
      ) VALUES (
        'assignment-1', 'legacy-approved', 'user-reviewer', 'user-approver', 1, '${now}', '${now}'
      );
    `);
  }

  if (options.approvedPointerWithDifferentDraft) {
    sqlite.exec(`
      INSERT INTO recordings (
        id, workspace_id, title, source, media_kind, mime_type, media_path,
        original_file_name, language_hint, uploaded_by_role, ingestion_session_id,
        transcript_job_id, integrity_state, transcript_job_state, current_revision_id,
        approved_revision_id, pending_revision_id, verification_summary, created_at,
        updated_at, automation_cursor
      ) VALUES (
        'legacy-reopened', 'workspace-1', 'Legacy reopened', 'upload', 'audio',
        'audio/wav', NULL, 'legacy-reopened.wav', 'english', 'uploader', NULL, NULL,
        'verified', 'completed', 'legacy-reopened-draft', 'legacy-reopened-approved', NULL,
        'Legacy reopened row.', '${now}', '${now}', NULL
      );

      INSERT INTO revisions (
        id, recording_id, version, state, based_on_revision_id, created_by_role,
        created_at, submitted_at, approved_at, summary, segments_json
      ) VALUES
      (
        'legacy-reopened-approved', 'legacy-reopened', 1, 'approved', NULL, 'reviewer',
        '${now}', '${now}', '${now}', 'Legacy approved revision', '[]'
      ),
      (
        'legacy-reopened-draft', 'legacy-reopened', 2, 'draft', 'legacy-reopened-approved', 'approver',
        '${now}', NULL, NULL, 'Legacy draft revision', '[]'
      );
    `);
  }
}

describe("migrations", () => {
  it("applies baseline and governed migrations exactly once", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite);
    runMigrations(sqlite);

    expect(sqlite.prepare("select version from schema_migrations order by version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
    ]);
  });

  it("upgrades a populated v2 database without touching existing user ids", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite, 2);
    seedCurrentSchemaFixture(sqlite);

    runMigrations(sqlite);

    expect(
      sqlite.prepare("select id, auth_version as authVersion from users order by id").all(),
    ).toEqual([
      { id: "user-approver", authVersion: 1 },
      { id: "user-reviewer", authVersion: 1 },
    ]);

    // The deployment-level legacy-session retirement event is recorded once.
    const events = sqlite
      .prepare("select type, outcome from security_events")
      .all() as Array<{ type: string; outcome: string }>;
    expect(events).toEqual([
      { type: "auth.legacy_sessions_invalidated", outcome: "success" },
    ]);

    // Re-running the migration must not duplicate the event.
    runMigrations(sqlite);
    expect(sqlite.prepare("select count(*) as count from security_events").get()).toEqual({
      count: 1,
    });
  });

  it("does not record a legacy-session event for a fresh empty database", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite);

    expect(sqlite.prepare("select count(*) as count from security_events").get()).toEqual({
      count: 0,
    });
  });

  it("rebuilds users with a nullable password hash while preserving rows and foreign keys", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");

    runMigrations(sqlite, 3);
    const now = "2026-08-03T00:00:00.000Z";
    sqlite.exec(`
      INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
        VALUES ('user-a', 'a@example.com', 'User A', 'hash-a', 'reviewer', 1, '${now}', '${now}');
      INSERT INTO auth_sessions (
        id, user_id, auth_source, auth_version, status, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at
      ) VALUES (
        'sess-1', 'user-a', 'local', 1, 'active', '${now}', '${now}', '${now}', '${now}'
      );
    `);

    runMigrations(sqlite);

    expect(
      sqlite.prepare("select id, password_hash as passwordHash, auth_version as authVersion from users").all(),
    ).toEqual([{ id: "user-a", passwordHash: "hash-a", authVersion: 1 }]);
    expect(
      sqlite.prepare("select id, user_id as userId from auth_sessions").all(),
    ).toEqual([{ id: "sess-1", userId: "user-a" }]);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // password_hash is nullable now: OIDC-only shadow users can exist.
    sqlite.exec(`
      INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
        VALUES ('user-shadow', 's@example.com', 'Shadow', NULL, 'uploader', 1, '${now}', '${now}');
    `);

    // Foreign keys still enforce after the rebuild.
    expect(() =>
      sqlite.exec(
        `INSERT INTO auth_sessions (
           id, user_id, auth_source, auth_version, status, created_at, last_seen_at,
           idle_expires_at, absolute_expires_at
         ) VALUES ('sess-bad', 'ghost', 'local', 1, 'active', '${now}', '${now}', '${now}', '${now}')`,
      ),
    ).toThrow();

    // The identity pair reservation index enforces forever-reservation.
    sqlite.exec(`
      INSERT INTO external_identities (
        id, user_id, issuer, subject, status, linked_at, change_reason
      ) VALUES ('link-1', 'user-a', 'https://issuer/', 'sub-1', 'retired', '${now}', 'test');
    `);
    expect(() =>
      sqlite.exec(`
        INSERT INTO external_identities (
          id, user_id, issuer, subject, status, linked_at, change_reason
        ) VALUES ('link-2', 'user-a', 'https://issuer/', 'sub-1', 'active', '${now}', 'test');
      `),
    ).toThrow(/UNIQUE/);
  });

  it("upgrades v7 with final-admin and assignment-role direct-writer guards", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite, 7);
    const now = "2026-08-08T00:00:00.000Z";

    sqlite.exec(`
      INSERT INTO policy_profiles (id, label, description)
        VALUES ('strict', 'Strict regulated mode', 'Strict regulated mode.');
      INSERT INTO workspaces (id, name, slug, policy_profile_id)
        VALUES ('workspace-role-guards', 'Workspace', 'workspace-role-guards', 'strict');
      INSERT INTO users (
        id, email, display_name, password_hash, role, is_active, auth_version,
        created_at, updated_at
      ) VALUES
        ('admin-1', 'admin-1@example.com', 'Admin One', 'hash', 'admin', 1, 1, '${now}', '${now}'),
        ('admin-2', 'admin-2@example.com', 'Admin Two', 'hash', 'admin', 1, 1, '${now}', '${now}'),
        ('assigned-reviewer', 'reviewer@example.com', 'Reviewer', 'hash', 'reviewer', 1, 1, '${now}', '${now}'),
        ('repair-user', 'repair@example.com', 'Repair User', 'hash', 'uploader', 1, 1, '${now}', '${now}');
      INSERT INTO recordings (
        id, workspace_id, title, source, media_kind, mime_type, media_path,
        original_file_name, language_hint, uploaded_by_role, uploaded_by_user_id,
        ingestion_session_id, transcript_job_id, integrity_state, transcript_job_state,
        current_revision_id, approved_revision_id, pending_revision_id,
        verification_summary, created_at, updated_at, automation_cursor
      ) VALUES (
        'rec-role-guards', 'workspace-role-guards', 'Role guard recording', 'upload',
        'audio', 'audio/wav', NULL, 'role-guard.wav', 'english', 'uploader', NULL,
        NULL, NULL, 'verified', 'completed', NULL, NULL, NULL, 'Ready',
        '${now}', '${now}', NULL
      );
      INSERT INTO recording_assignments (
        id, recording_id, user_id, assigned_by_user_id, assignment_role, status,
        is_active, created_at, updated_at
      ) VALUES
        ('assignment-reviewer', 'rec-role-guards', 'assigned-reviewer', 'admin-1',
          'reviewer', 'active', 1, '${now}', '${now}'),
        ('assignment-repair', 'rec-role-guards', 'repair-user', 'admin-1',
          'reviewer', 'active', 1, '${now}', '${now}');
    `);

    runMigrations(sqlite);
    runMigrations(sqlite);

    expect(
      sqlite.prepare("select version from schema_migrations order by version").all(),
    ).toContainEqual({ version: 8 });
    expect(
      sqlite
        .prepare(
          "select count(*) as count from sqlite_master where type = 'trigger' and name like '%role_guard%'",
        )
        .get(),
    ).toEqual({ count: 4 });

    sqlite.prepare("update users set is_active = 0 where id = 'admin-2'").run();
    expect(() =>
      sqlite.prepare("update users set role = 'reviewer' where id = 'admin-1'").run(),
    ).toThrow(/at least one active administrator must remain/);
    sqlite.prepare("update users set is_active = 1 where id = 'admin-2'").run();

    expect(() =>
      sqlite
        .prepare("update users set role = 'uploader' where id = 'assigned-reviewer'")
        .run(),
    ).toThrow(/active assignments must match the user's role/);

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO recording_assignments (
            id, recording_id, user_id, assigned_by_user_id, assignment_role, status,
            is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'approver', 'active', 1, ?, ?)`,
        )
        .run(
          "bad-assignment",
          "rec-role-guards",
          "assigned-reviewer",
          "admin-2",
          now,
          now,
        ),
    ).toThrow(/active assignment role must match the assigned user's role/);

    sqlite
      .prepare(
        `INSERT INTO recording_assignments (
          id, recording_id, user_id, assigned_by_user_id, assignment_role, status,
          is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'approver', 'removed', 0, ?, ?)`,
      )
      .run(
        "historical-assignment",
        "rec-role-guards",
        "assigned-reviewer",
        "admin-2",
        now,
        now,
      );
    expect(() =>
      sqlite
        .prepare(
          "update recording_assignments set status = 'active', is_active = 1 where id = 'historical-assignment'",
        )
        .run(),
    ).toThrow(/active assignment role must match the assigned user's role/);

    expect(() =>
      sqlite.prepare("update users set role = 'reviewer' where id = 'repair-user'").run(),
    ).not.toThrow();
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    sqlite.close();
  });

  it("preserves legacy rows and normalizes approved assignments and reopened pointers", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite, 1);
    seedCurrentSchemaFixture(sqlite, {
      approvedWithActiveAssignments: true,
      approvedPointerWithDifferentDraft: true,
    });

    runMigrations(sqlite);

    expect(sqlite.prepare("select status, end_reason from recording_assignments").all()).toContainEqual({
      status: "completed",
      end_reason: "legacy_approved_backfill",
    });
    expect(
      sqlite
        .prepare("select approved_revision_id from recordings where id = ?")
        .get("legacy-reopened"),
    ).toEqual({ approved_revision_id: null });
  });

  it("adds a nullable per-user theme preference at v9 without touching user rows", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");

    runMigrations(sqlite, 8);
    const now = "2026-08-10T00:00:00.000Z";
    sqlite.exec(`
      INSERT INTO policy_profiles (id, label, description)
        VALUES ('strict', 'Strict regulated mode', 'Strict regulated mode.');
      INSERT INTO workspaces (id, name, slug, policy_profile_id)
        VALUES ('workspace-theme', 'Workspace', 'workspace-theme', 'strict');
      INSERT INTO users (
        id, email, display_name, password_hash, role, is_active, auth_version,
        created_at, updated_at
      ) VALUES
        ('user-theme', 'theme@example.com', 'Theme User', 'hash', 'reviewer', 1, 1, '${now}', '${now}');
    `);

    runMigrations(sqlite);

    expect(
      sqlite.prepare("select id, theme_preference as themePreference from users").all(),
    ).toEqual([{ id: "user-theme", themePreference: null }]);

    // The column accepts the three contract values and round-trips updates.
    sqlite
      .prepare("update users set theme_preference = ? where id = ?")
      .run("dark", "user-theme");
    expect(
      sqlite.prepare("select theme_preference as themePreference from users where id = 'user-theme'").get(),
    ).toEqual({ themePreference: "dark" });

    // Idempotent: re-running the full chain keeps the stored preference.
    runMigrations(sqlite);
    expect(
      sqlite.prepare("select theme_preference as themePreference from users where id = 'user-theme'").get(),
    ).toEqual({ themePreference: "dark" });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
