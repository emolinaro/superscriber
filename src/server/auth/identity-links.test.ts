import { describe, expect, it } from "vitest";
import {
  applyIdentityLink,
  assertUserDeletionBlocked,
  offboardLinkedUser,
  relinkIdentity,
  resolveIdentityLink,
  retireIdentityLink,
} from "@/server/auth/identity-links";
import { createAuthSession, validateAuthSession } from "@/server/auth/session-registry";
import { verifyLocalCredentials } from "@/server/auth/service";
import { openAppDatabase } from "@/server/db/client";

const ISSUER = "https://auth.example.com/application/o/superscriber/";
const OTHER_ISSUER = "https://auth.example.com/application/o/other/";
const NOW = new Date("2026-08-03T12:00:00.000Z");

function setup() {
  const bundle = openAppDatabase(":memory:");
  const insert = bundle.sqlite.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  insert.run("user-a", "a@example.com", "User A", "hash-a", "reviewer", NOW.toISOString(), NOW.toISOString());
  insert.run("user-b", "b@example.com", "User B", "hash-b", "approver", NOW.toISOString(), NOW.toISOString());
  insert.run("user-shadow", "shadow@example.com", "Shadow", null, "uploader", NOW.toISOString(), NOW.toISOString());
  insert.run("user-operator", "op@example.com", "Operator", "hash-op", "admin", NOW.toISOString(), NOW.toISOString());
  return bundle;
}

function linkRows(sqlite: import("better-sqlite3").Database) {
  return sqlite
    .prepare(`SELECT user_id AS userId, issuer, subject, status, change_reason AS changeReason FROM external_identities ORDER BY linked_at, rowid`)
    .all() as Array<{ userId: string; issuer: string; subject: string; status: string; changeReason: string }>;
}

describe("identity links", () => {
  it("links an exact validated issuer/subject pair to an existing local user", () => {
    const { db } = setup();

    const link = applyIdentityLink(
      {
        userId: "user-a",
        issuer: ISSUER,
        subject: "sub-1",
        linkedByUserId: "user-operator",
        changeReason: "Initial provisioning.",
        now: NOW,
      },
      db,
    );

    expect(link.status).toBe("active");
    expect(resolveIdentityLink(ISSUER, "sub-1", db)).toMatchObject({
      status: "linked",
      user: { id: "user-a", role: "reviewer" },
    });
  });

  it("returns unlinked for an unknown pair without creating anything", () => {
    const { db } = setup();
    expect(resolveIdentityLink(ISSUER, "nope", db)).toEqual({ status: "unlinked" });
  });

  it("matches issuer and subject exactly with no normalization", () => {
    const { db } = setup();
    applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "Sub-Case", linkedByUserId: "user-operator", changeReason: "x" },
      db,
    );

    expect(resolveIdentityLink(ISSUER.toUpperCase(), "Sub-Case", db)).toEqual({ status: "unlinked" });
    expect(resolveIdentityLink(ISSUER.slice(0, -1), "Sub-Case", db)).toEqual({ status: "unlinked" });
    expect(resolveIdentityLink(ISSUER, "sub-case", db)).toEqual({ status: "unlinked" });
    expect(resolveIdentityLink(ISSUER, "Sub-Case", db)).toMatchObject({ status: "linked" });
  });

  it("reserves a pair forever: relinking it to another user is denied even after retirement", () => {
    const { db } = setup();
    const link = applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-1", linkedByUserId: "user-operator", changeReason: "Initial." },
      db,
    );

    expect(() =>
      applyIdentityLink(
        { userId: "user-b", issuer: ISSUER, subject: "sub-1", linkedByUserId: "user-operator", changeReason: "Takeover attempt." },
        db,
      ),
    ).toThrow(/reserved/i);

    retireIdentityLink(
      { identityId: link.id, retiredByUserId: "user-operator", changeReason: "Offboarded." },
      db,
    );

    expect(() =>
      applyIdentityLink(
        { userId: "user-b", issuer: ISSUER, subject: "sub-1", linkedByUserId: "user-operator", changeReason: "Reuse attempt." },
        db,
      ),
    ).toThrow(/reserved/i);
  });

  it("denies a second active link for the same user and issuer", () => {
    const { db } = setup();
    applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-1", linkedByUserId: "user-operator", changeReason: "First." },
      db,
    );

    expect(() =>
      applyIdentityLink(
        { userId: "user-a", issuer: ISSUER, subject: "sub-2", linkedByUserId: "user-operator", changeReason: "Second." },
        db,
      ),
    ).toThrow(/already has an active link/i);

    // A different issuer namespace is allowed.
    const other = applyIdentityLink(
      { userId: "user-a", issuer: OTHER_ISSUER, subject: "sub-9", linkedByUserId: "user-operator", changeReason: "Second issuer." },
      db,
    );
    expect(other.status).toBe("active");
  });

  it("relinks a changed subject by retiring and inserting in one audited operation", () => {
    const { db, sqlite } = setup();
    applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-old", linkedByUserId: "user-operator", changeReason: "Initial." },
      db,
    );

    const result = relinkIdentity(
      {
        userId: "user-a",
        issuer: ISSUER,
        newSubject: "sub-new",
        actorUserId: "user-operator",
        changeReason: "Subject changed after independent proof.",
      },
      db,
    );

    expect(result.retired.subject).toBe("sub-old");
    expect(result.link.subject).toBe("sub-new");
    expect(linkRows(sqlite)).toEqual([
      expect.objectContaining({ userId: "user-a", subject: "sub-old", status: "retired" }),
      expect.objectContaining({ userId: "user-a", subject: "sub-new", status: "active" }),
    ]);
    expect(resolveIdentityLink(ISSUER, "sub-new", db)).toMatchObject({ status: "linked" });
    expect(resolveIdentityLink(ISSUER, "sub-old", db)).toMatchObject({ status: "retired" });
  });

  it("is indifferent to local email or display-name renames", () => {
    const { db, sqlite } = setup();
    applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-1", linkedByUserId: "user-operator", changeReason: "Initial." },
      db,
    );

    sqlite
      .prepare(`UPDATE users SET email = 'renamed@example.com', display_name = 'Renamed A' WHERE id = 'user-a'`)
      .run();

    const resolved = resolveIdentityLink(ISSUER, "sub-1", db);
    expect(resolved).toMatchObject({
      status: "linked",
      user: { id: "user-a", email: "renamed@example.com", displayName: "Renamed A" },
    });
  });

  it("offboards by revoking sessions and deactivating, preserving link and history", () => {
    const { db, sqlite } = setup();
    applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-1", linkedByUserId: "user-operator", changeReason: "Initial." },
      db,
    );
    const session = createAuthSession({ userId: "user-a", authSource: "authentik", now: NOW }, db);

    offboardLinkedUser(
      { userId: "user-a", actorUserId: "user-operator", changeReason: "Authentik account disabled." },
      db,
    );

    const user = sqlite
      .prepare(`SELECT is_active AS isActive, auth_version AS authVersion FROM users WHERE id = 'user-a'`)
      .get() as { isActive: number; authVersion: number };
    expect(user.isActive).toBe(0);
    expect(user.authVersion).toBe(2);
    expect(validateAuthSession(session.id, { now: new Date(NOW.getTime() + 1000) }, db)).toEqual({
      ok: false,
      reason: "revoked",
    });

    // Link and history survive; login stays denied.
    expect(resolveIdentityLink(ISSUER, "sub-1", db)).toMatchObject({
      status: "linked",
      user: { id: "user-a", isActive: false },
    });
  });

  it("blocks local user deletion while governance references exist", () => {
    const { db, sqlite } = setup();

    // No references yet: deletion is not blocked by this guard.
    expect(() => assertUserDeletionBlocked("user-shadow", db)).not.toThrow();

    applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "sub-1", linkedByUserId: "user-operator", changeReason: "Initial." },
      db,
    );
    expect(() => assertUserDeletionBlocked("user-a", db)).toThrow(/identity link/i);

    // An audit event reference also blocks deletion.
    sqlite.exec(`
      INSERT INTO policy_profiles (id, label, description) VALUES ('strict', 'Strict', 'Strict.');
      INSERT INTO workspaces (id, name, slug, policy_profile_id) VALUES ('ws-1', 'WS', 'ws', 'strict');
      INSERT INTO recordings (
        id, workspace_id, title, source, media_kind, language_hint, uploaded_by_role,
        integrity_state, transcript_job_state, created_at, updated_at
      ) VALUES ('rec-1', 'ws-1', 'R', 'upload', 'audio', 'english', 'uploader', 'pending', 'queued', '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO audit_events (
        id, workspace_id, recording_id, actor_role, actor_user_id, type, detail, metadata, created_at
      ) VALUES ('aud-1', 'ws-1', 'rec-1', 'reviewer', 'user-b', 'revision.saved', 'Saved.', '{"version":1,"data":{}}', '${NOW.toISOString()}');
    `);
    expect(() => assertUserDeletionBlocked("user-b", db)).toThrow(/audit/i);
  });

  it("never allows credentials login for a shadow user with no password hash", async () => {
    const { db } = setup();
    expect(
      await verifyLocalCredentials({ email: "shadow@example.com", password: "anything" }, db),
    ).toBeNull();
  });
});
