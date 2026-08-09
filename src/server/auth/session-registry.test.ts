import { describe, expect, it } from "vitest";
import {
  bumpUserAuthVersion,
  createAuthSession,
  retireUserSessions,
  revokeAuthSession,
  revokeUserSessions,
  validateAuthSession,
} from "@/server/auth/session-registry";
import { openAppDatabase } from "@/server/db/client";

const T0 = new Date("2026-08-03T12:00:00.000Z");

function seedUser(sqlite: import("better-sqlite3").Database, id: string, role = "reviewer") {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', ?, 1, ?, ?)`,
    )
    .run(id, `${id}@example.com`, id, role, T0.toISOString(), T0.toISOString());
}

function authSessionRow(sqlite: import("better-sqlite3").Database, id: string) {
  return sqlite.prepare(`SELECT * FROM auth_sessions WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
}

function securityEventRows(sqlite: import("better-sqlite3").Database) {
  return sqlite
    .prepare(`SELECT type, outcome, user_id AS userId, session_id AS sessionId, detail FROM security_events ORDER BY created_at`)
    .all() as Array<{
    type: string;
    outcome: string;
    userId: string | null;
    sessionId: string | null;
    detail: string;
  }>;
}

function setup() {
  const bundle = openAppDatabase(":memory:");
  seedUser(bundle.sqlite, "user-1");
  seedUser(bundle.sqlite, "user-2");
  return bundle;
}

describe("session registry", () => {
  it("creates an active local session with normal idle and absolute bounds", () => {
    const { db, sqlite } = setup();

    const created = createAuthSession(
      { userId: "user-1", authSource: "local", now: T0 },
      db,
    );

    expect(created.status).toBe("active");
    expect(created.authSource).toBe("local");
    expect(created.authVersion).toBe(1);
    expect(Date.parse(created.absoluteExpiresAt) - T0.getTime()).toBe(8 * 60 * 60 * 1000);
    expect(Date.parse(created.idleExpiresAt) - T0.getTime()).toBe(30 * 60 * 1000);

    const events = securityEventRows(sqlite);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "auth.session.created",
      outcome: "success",
      userId: "user-1",
      sessionId: created.id,
    });
  });

  it("creates break-glass sessions with shortened idle and absolute bounds", () => {
    const { db } = setup();

    const created = createAuthSession(
      { userId: "user-1", authSource: "break_glass", now: T0 },
      db,
    );

    expect(Date.parse(created.absoluteExpiresAt) - T0.getTime()).toBe(15 * 60 * 1000);
    expect(Date.parse(created.idleExpiresAt) - T0.getTime()).toBe(5 * 60 * 1000);
  });

  it("refuses to create a session for an unknown user", () => {
    const { db } = setup();
    expect(() => createAuthSession({ userId: "ghost", authSource: "local" }, db)).toThrow();
  });

  it("validates an active session and resolves the live user row", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    // Role changes after the session is created must be observed live.
    sqlite.prepare(`UPDATE users SET role = 'approver', display_name = 'Renamed' WHERE id = 'user-1'`).run();

    const validation = validateAuthSession(
      created.id,
      { now: new Date(T0.getTime() + 1000) },
      db,
    );

    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.user.id).toBe("user-1");
      expect(validation.user.role).toBe("approver");
      expect(validation.user.displayName).toBe("Renamed");
    }
  });

  it("rejects an unknown session id", () => {
    const { db } = setup();
    expect(validateAuthSession("missing", { now: T0 }, db)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects a revoked session", () => {
    const { db } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);
    revokeAuthSession(created.id, "test_revocation", db);

    expect(validateAuthSession(created.id, { now: new Date(T0.getTime() + 1000) }, db)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("lazily marks idle-expired sessions and denies them", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    const validation = validateAuthSession(
      created.id,
      { now: new Date(T0.getTime() + 31 * 60 * 1000) },
      db,
    );

    expect(validation).toEqual({ ok: false, reason: "idle_expired" });
    expect(authSessionRow(sqlite, created.id).status).toBe("expired");
    expect(securityEventRows(sqlite).map((row) => row.type)).toContain("auth.session.expired");
  });

  it("lazily marks absolute-expired sessions and denies them", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    const validation = validateAuthSession(
      created.id,
      { now: new Date(T0.getTime() + 8 * 60 * 60 * 1000 + 1000) },
      db,
    );

    expect(validation).toEqual({ ok: false, reason: "absolute_expired" });
    expect(authSessionRow(sqlite, created.id).status).toBe("expired");
  });

  it("denies sessions whose auth version no longer matches the user", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    bumpUserAuthVersion("user-1", db);

    const validation = validateAuthSession(
      created.id,
      { now: new Date(T0.getTime() + 1000) },
      db,
    );

    expect(validation).toEqual({ ok: false, reason: "auth_version_mismatch" });
    expect(authSessionRow(sqlite, created.id).status).toBe("revoked");
    expect(authSessionRow(sqlite, created.id).revoked_reason).toBe("auth_version_changed");
  });

  it("denies sessions for suspended users and revokes them", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = 'user-1'`).run();

    const validation = validateAuthSession(
      created.id,
      { now: new Date(T0.getTime() + 1000) },
      db,
    );

    expect(validation).toEqual({ ok: false, reason: "user_inactive" });
    expect(authSessionRow(sqlite, created.id).status).toBe("revoked");
    expect(authSessionRow(sqlite, created.id).revoked_reason).toBe("user_inactive");
  });

  it("slides the idle expiry on activity with a throttled last_seen write", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    // Within the throttle window: no writes.
    const early = validateAuthSession(created.id, { now: new Date(T0.getTime() + 30_000) }, db);
    expect(early.ok).toBe(true);
    expect(authSessionRow(sqlite, created.id).last_seen_at).toBe(T0.toISOString());

    // Past the throttle window: last_seen updates and idle expiry slides.
    const later = new Date(T0.getTime() + 10 * 60 * 1000);
    const late = validateAuthSession(created.id, { now: later }, db);
    expect(late.ok).toBe(true);

    const row = authSessionRow(sqlite, created.id);
    expect(row.last_seen_at).toBe(later.toISOString());
    expect(Date.parse(row.idle_expires_at as string) - later.getTime()).toBe(30 * 60 * 1000);
  });

  it("revokes a single session and records the event", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    expect(revokeAuthSession(created.id, "operator_revoke", db)).toBe(true);
    expect(revokeAuthSession(created.id, "operator_revoke", db)).toBe(false);

    const row = authSessionRow(sqlite, created.id);
    expect(row.status).toBe("revoked");
    expect(row.revoked_reason).toBe("operator_revoke");
    expect(securityEventRows(sqlite).map((event) => event.type)).toContain(
      "auth.session.revoked",
    );
  });

  it("revokes every active session for a user", () => {
    const { db } = setup();
    const first = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);
    const second = createAuthSession(
      { userId: "user-1", authSource: "local", now: new Date(T0.getTime() + 1000) },
      db,
    );
    const other = createAuthSession({ userId: "user-2", authSource: "local", now: T0 }, db);

    expect(revokeUserSessions("user-1", "password_rotated", db)).toBe(2);

    const at = new Date(T0.getTime() + 2000);
    expect(validateAuthSession(first.id, { now: at }, db)).toEqual({ ok: false, reason: "revoked" });
    expect(validateAuthSession(second.id, { now: at }, db)).toEqual({ ok: false, reason: "revoked" });
    expect(validateAuthSession(other.id, { now: at }, db).ok).toBe(true);
  });

  it("uses the caller's timestamp for role-change revocations and diagnostics", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);
    const revokedAt = new Date("2026-08-03T12:05:00.000Z");

    expect(
      revokeUserSessions("user-1", "account_role_changed", db, { now: revokedAt }),
    ).toBe(1);
    expect(authSessionRow(sqlite, created.id)).toMatchObject({
      status: "revoked",
      revoked_at: revokedAt.toISOString(),
      revoked_reason: "account_role_changed",
    });
    expect(
      sqlite
        .prepare(
          `SELECT created_at AS createdAt FROM security_events
           WHERE type = 'auth.session.revoked' AND session_id = ?`,
        )
        .get(created.id),
    ).toEqual({ createdAt: revokedAt.toISOString() });
  });

  it("retires a user's sessions and bumps their auth version in one step", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    retireUserSessions({ userId: "user-1", reason: "suspended" }, db);

    const user = sqlite
      .prepare(`SELECT auth_version AS authVersion FROM users WHERE id = 'user-1'`)
      .get() as { authVersion: number };
    expect(user.authVersion).toBe(2);
    expect(validateAuthSession(created.id, { now: new Date(T0.getTime() + 1000) }, db)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("fails closed when the database is unavailable", () => {
    const { db, sqlite } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);
    sqlite.close();

    expect(validateAuthSession(created.id, { now: T0 }, db)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("keeps validation reads fast enough for the live-authorization budget", async () => {
    const { db } = setup();
    const created = createAuthSession({ userId: "user-1", authSource: "local", now: T0 }, db);

    const samples: number[] = [];
    for (let index = 0; index < 300; index += 1) {
      const started = performance.now();
      const result = validateAuthSession(
        created.id,
        { now: new Date(T0.getTime() + index * 1000) },
        db,
      );
      samples.push(performance.now() - started);
      expect(result.ok).toBe(true);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(20);
  });
});
