import { describe, expect, it } from "vitest";
import {
  designateBreakGlassUser,
  getBreakGlassDesignation,
  openEmergencyActivation,
  rotateBreakGlassPassword,
  transferBreakGlassDesignation,
  verifyBreakGlassPassword,
} from "@/server/auth/break-glass";
import { createAuthSession, validateAuthSession } from "@/server/auth/session-registry";
import { verifyLocalCredentials } from "@/server/auth/service";
import { hash } from "bcryptjs";
import { openAppDatabase } from "@/server/db/client";

const NOW = new Date("2026-08-03T12:00:00.000Z");

async function setup() {
  const bundle = openAppDatabase(":memory:");
  const adminHash = await hash("Superscriber!123", 12);
  const insert = bundle.sqlite.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  insert.run("admin-1", "a@example.com", "Admin One", adminHash, "admin", NOW.toISOString(), NOW.toISOString());
  insert.run("admin-2", "b@example.com", "Admin Two", adminHash, "admin", NOW.toISOString(), NOW.toISOString());
  insert.run("reviewer-1", "r@example.com", "Reviewer", adminHash, "reviewer", NOW.toISOString(), NOW.toISOString());
  return bundle;
}

describe("break-glass designation", () => {
  it("designates exactly one active admin and records it via the singleton", async () => {
    const { db } = await setup();

    designateBreakGlassUser(
      { userId: "admin-1", actorUserId: null, changeReason: "Initial designation." },
      db,
    );

    expect(getBreakGlassDesignation(db)).toMatchObject({
      breakGlassUserId: "admin-1",
      changeReason: "Initial designation.",
    });

    // A second designation row cannot coexist: transfer reuses the singleton.
    designateBreakGlassUser(
      { userId: "admin-2", actorUserId: null, changeReason: "Transfer." },
      db,
    );
    expect(getBreakGlassDesignation(db)?.breakGlassUserId).toBe("admin-2");
  });

  it("rejects designation of non-admin or inactive users at trigger and service level", async () => {
    const { db, sqlite } = await setup();

    expect(() =>
      designateBreakGlassUser(
        { userId: "reviewer-1", actorUserId: null, changeReason: "Not an admin." },
        db,
      ),
    ).toThrow(/admin/i);

    sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = 'admin-2'`).run();
    expect(() =>
      designateBreakGlassUser(
        { userId: "admin-2", actorUserId: null, changeReason: "Inactive." },
        db,
      ),
    ).toThrow(/admin/i);
  });

  it("blocks demotion, deactivation, and deletion of the designated user via triggers", async () => {
    const { db, sqlite } = await setup();
    designateBreakGlassUser(
      { userId: "admin-1", actorUserId: null, changeReason: "Initial." },
      db,
    );

    expect(() =>
      sqlite.prepare(`UPDATE users SET role = 'reviewer' WHERE id = 'admin-1'`).run(),
    ).toThrow(/break-glass/i);
    expect(() =>
      sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = 'admin-1'`).run(),
    ).toThrow(/break-glass/i);
    expect(() => sqlite.prepare(`DELETE FROM users WHERE id = 'admin-1'`).run()).toThrow(
      /break-glass/i,
    );

    // Normal updates still work.
    expect(() =>
      sqlite.prepare(`UPDATE users SET display_name = 'Renamed' WHERE id = 'admin-1'`).run(),
    ).not.toThrow();
  });

  it("transfers atomically: old path disabled, sessions revoked, pointer moved", async () => {
    const { db, sqlite } = await setup();
    designateBreakGlassUser(
      { userId: "admin-1", actorUserId: null, changeReason: "Initial." },
      db,
    );
    const session = createAuthSession({ userId: "admin-1", authSource: "break_glass" }, db);

    transferBreakGlassDesignation(
      { newUserId: "admin-2", actorUserId: null, changeReason: "Custodian change." },
      db,
    );

    expect(getBreakGlassDesignation(db)?.breakGlassUserId).toBe("admin-2");

    // The old account can no longer pass credentials and its session is dead.
    expect(await verifyLocalCredentials({ email: "a@example.com", password: "Superscriber!123" }, db)).toBeNull();
    expect(validateAuthSession(session.id, {}, db)).toEqual({ ok: false, reason: "revoked" });

    // The new designee still authenticates locally.
    expect(await verifyLocalCredentials({ email: "b@example.com", password: "Superscriber!123" }, db)).toMatchObject(
      { id: "admin-2" },
    );

    const eventRow = sqlite
      .prepare(`SELECT type FROM security_events WHERE type = 'breakglass.transferred'`)
      .get();
    expect(eventRow).toBeTruthy();
  });

  it("verifies the designated account password only", async () => {
    const { db } = await setup();
    designateBreakGlassUser(
      { userId: "admin-1", actorUserId: null, changeReason: "Initial." },
      db,
    );

    expect(await verifyBreakGlassPassword({ userId: "admin-1", password: "Superscriber!123" }, db)).toBe(true);
    expect(await verifyBreakGlassPassword({ userId: "admin-1", password: "nope" }, db)).toBe(false);
    // Not the designated account.
    expect(await verifyBreakGlassPassword({ userId: "admin-2", password: "Superscriber!123" }, db)).toBe(false);
  });

  it("rotates the password, invalidating the old one and existing sessions", async () => {
    const { db } = await setup();
    designateBreakGlassUser(
      { userId: "admin-1", actorUserId: null, changeReason: "Initial." },
      db,
    );
    const session = createAuthSession({ userId: "admin-1", authSource: "break_glass" }, db);

    await rotateBreakGlassPassword(
      { userId: "admin-1", newPassword: "Rotation!4567890123", actorUserId: null, changeReason: "90-day rotation." },
      db,
    );

    expect(await verifyBreakGlassPassword({ userId: "admin-1", password: "Superscriber!123" }, db)).toBe(false);
    expect(await verifyBreakGlassPassword({ userId: "admin-1", password: "Rotation!4567890123" }, db)).toBe(true);
    expect(validateAuthSession(session.id, {}, db)).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("emergency activation", () => {
  it("opens an activation with a break-glass session and correlation id", async () => {
    const { db, sqlite } = await setup();
    designateBreakGlassUser(
      { userId: "admin-1", actorUserId: null, changeReason: "Initial." },
      db,
    );

    const { activation, session } = openEmergencyActivation(
      {
        userId: "admin-1",
        reason: "IdP outage during regional maintenance window.",
        sourceZone: "management",
        now: NOW,
      },
      db,
    );

    expect(activation.correlationId).toBeTruthy();
    expect(session.authSource).toBe("break_glass");
    expect(session.emergencyActivationId).toBe(activation.id);
    expect(Date.parse(session.absoluteExpiresAt) - NOW.getTime()).toBe(15 * 60 * 1000);

    const eventRow = sqlite
      .prepare(
        `SELECT type, outcome, user_id AS userId, correlation_id AS correlationId, source_zone AS zone
         FROM security_events WHERE type = 'breakglass.emergency_opened'`,
      )
      .get() as Record<string, unknown>;
    expect(eventRow).toMatchObject({
      outcome: "success",
      userId: "admin-1",
      correlationId: activation.correlationId,
      zone: "management",
    });
  });

  it("rejects reasons outside the 10-500 character bounds", async () => {
    const { db } = await setup();
    designateBreakGlassUser(
      { userId: "admin-1", actorUserId: null, changeReason: "Initial." },
      db,
    );

    expect(() =>
      openEmergencyActivation({ userId: "admin-1", reason: "short", sourceZone: "management" }, db),
    ).toThrow(/reason/i);
    expect(() =>
      openEmergencyActivation(
        { userId: "admin-1", reason: "x".repeat(501), sourceZone: "management" },
        db,
      ),
    ).toThrow(/reason/i);
  });
});
