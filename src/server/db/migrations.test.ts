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
    ]);
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
});
