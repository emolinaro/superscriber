import { compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase } from "@/server/db/client";
import {
  authControl,
  authSessions,
  auditEvents,
  externalIdentities,
  users,
} from "@/server/db/schema";
import { completeMandatoryPasswordChange } from "@/server/auth/account-lifecycle";
import { createLocalUser, verifyLocalCredentials } from "@/server/auth/service";
import {
  changeAccountLifecycle,
  createAccountWithTemporaryPassword,
} from "./account-lifecycle-service";

let bundle: ReturnType<typeof openAppDatabase>;
const now = new Date().toISOString();
function addUser(id: string, role: "admin" | "reviewer" = "reviewer") {
  bundle.db
    .insert(users)
    .values({
      id,
      displayName: id,
      email: `${id}@example.com`,
      role,
      passwordHash: "hash",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  bundle.db
    .insert(authSessions)
    .values({
      id: `session-${id}`,
      userId: id,
      authSource: "local",
      authVersion: 1,
      status: "active",
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: "2099-01-01T00:00:00.000Z",
      absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
    })
    .run();
}
const actor = { actorUserId: "admin", actorAuthSessionId: "session-admin" };
function change(
  action: "deactivate" | "reactivate" | "remove",
  userId = "target",
  expectedIsActive = true,
  reason = "Staffing change",
) {
  return changeAccountLifecycle(
    { ...actor, input: { action, userId, expectedIsActive, reason } },
    bundle,
  );
}
function target() {
  return bundle.db.select().from(users).where(eq(users.id, "target")).get()!;
}

beforeEach(() => {
  bundle = openAppDatabase(":memory:");
  addUser("admin", "admin");
  addUser("target");
});
afterEach(() => bundle.sqlite.close());

describe("governed account lifecycle", () => {
  it("deactivates durably, revokes sessions, attributes an audit and only explicitly reactivates", async () => {
    change("deactivate");
    expect(target()).toMatchObject({ isActive: false, authVersion: 2 });
    expect(
      bundle.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, "target"))
        .get()?.status,
    ).toBe("revoked");
    expect(bundle.db.select().from(auditEvents).get()).toMatchObject({
      type: "account.deactivated",
      actorUserId: "admin",
    });
    expect(
      JSON.parse(bundle.db.select().from(auditEvents).get()!.metadata).data,
    ).toMatchObject({ reason: "Staffing change", targetUserId: "target" });
    change("reactivate", "target", false);
    expect(target()).toMatchObject({ isActive: true, authVersion: 3 });
    expect(
      bundle.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, "target"))
        .get()?.status,
    ).toBe("revoked");
  });
  it.each(["deactivate", "remove"] as const)(
    "protects final admin from %s",
    (action) => {
      expect(() => change(action, "admin")).toThrow(
        /last active administrator/i,
      );
    },
  );
  it.each(["deactivate", "remove"] as const)(
    "refuses self %s even with a second admin",
    (action) => {
      addUser("other", "admin");
      expect(() => change(action, "admin")).toThrow(/own account/i);
    },
  );
  it.each(["deactivate", "remove"] as const)(
    "protects designated break-glass admin from %s",
    (action) => {
      addUser("custodian", "admin");
      bundle.db
        .insert(authControl)
        .values({
          id: 1,
          breakGlassUserId: "custodian",
          updatedAt: now,
          updatedByUserId: "admin",
          changeReason: "Test",
        })
        .run();
      expect(() => change(action, "custodian")).toThrow(/break-glass/i);
    },
  );
  it("rejects a blank reason and stale target state without changes", () => {
    expect(() => change("deactivate", "target", true, " ")).toThrow(/reason/i);
    expect(() => change("reactivate", "target", false)).toThrow(/changed/i);
    expect(target().isActive).toBe(true);
  });
  it.each(["revoked", "expired"] as const)(
    "revalidates %s actor sessions",
    (status) => {
      bundle.db
        .update(authSessions)
        .set({ status })
        .where(eq(authSessions.id, "session-admin"))
        .run();
      expect(() => change("deactivate")).toThrow(/active administrator/i);
      expect(target().isActive).toBe(true);
    },
  );
  it("revalidates actor role and auth version", () => {
    addUser("other", "admin");
    bundle.db
      .update(users)
      .set({ role: "reviewer", authVersion: 2 })
      .where(eq(users.id, "admin"))
      .run();
    expect(() => change("deactivate")).toThrow(/active administrator/i);
  });
  it("removal offboards without deleting identity or session references", () => {
    const originalEmail = target().email;
    bundle.db
      .insert(externalIdentities)
      .values({
        id: "link",
        userId: "target",
        issuer: "https://idp.example",
        subject: "target",
        status: "active",
        linkedAt: now,
        changeReason: "Test",
      })
      .run();
    change("deactivate");
    expect(bundle.db.select().from(externalIdentities).get()?.status).toBe(
      "active",
    );
    change("reactivate", "target", false);
    change("remove");
    expect(target()).toMatchObject({
      email: "removed:target",
      isActive: false,
      passwordHash: null,
    });
    expect(target().removedAt).toEqual(expect.any(String));
    expect(
      bundle.db.select().from(users).where(eq(users.email, originalEmail)).get(),
    ).toBeUndefined();
    expect(() => change("reactivate", "target", false)).toThrow(
      /Removed accounts are terminal/i,
    );
    expect(bundle.db.select().from(externalIdentities).get()).toMatchObject({
      userId: "target",
      status: "retired",
      retiredByUserId: "admin",
    });
    expect(
      bundle.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, "target"))
        .get(),
    ).toBeDefined();
    const removalAudit = bundle.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.type, "account.removed"))
      .get()!;
    expect(JSON.parse(removalAudit.metadata).data).toMatchObject({
      targetUserId: "target",
    });
    expect(bundle.sqlite.pragma("foreign_key_check")).toEqual([]);
  });
  it("lets a returning person use a released email for fresh accounts", async () => {
    const localEmail = target().email;
    change("remove");

    const returningLocal = await createLocalUser(
      {
        displayName: "Returning Local",
        email: localEmail,
        password: "returning-local-secret",
        role: "reviewer",
      },
      bundle.db,
    );
    expect(returningLocal).toMatchObject({ email: localEmail, isActive: true });
    expect(returningLocal.id).not.toBe("target");

    addUser("temp-returning");
    const tempEmail = "temp-returning@example.com";
    change("remove", "temp-returning");
    const returningTemporary = await createAccountWithTemporaryPassword(
      {
        ...actor,
        input: {
          displayName: "Returning Temporary",
          email: tempEmail,
          role: "reviewer",
          reason: "Returned after removal",
        },
      },
      bundle,
    );
    expect(returningTemporary.user).toMatchObject({
      email: tempEmail,
      isActive: true,
    });
    expect(returningTemporary.user.id).not.toBe("temp-returning");
  });
  it("rolls back deactivation and session revocation if audit insertion fails", () => {
    bundle.sqlite.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() => change("deactivate")).toThrow();
    expect(target()).toMatchObject({ isActive: true, authVersion: 1 });
    expect(
      bundle.db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, "target"))
        .get()?.status,
    ).toBe("active");
  });
  it("creates a usable generated secret, stores only its hash and never revives duplicate email", async () => {
    const result = await createAccountWithTemporaryPassword(
      {
        ...actor,
        input: {
          displayName: "New Account",
          email: " NEW@example.com ",
          role: "reviewer",
          reason: "New colleague",
        },
      },
      bundle,
    );
    const row = bundle.db
      .select()
      .from(users)
      .where(eq(users.id, result.user.id))
      .get()!;
    expect(row.mustChangePassword).toBe(true);
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(24);
    expect(await compare(result.temporaryPassword, row.passwordHash!)).toBe(
      true,
    );
    expect(
      JSON.stringify(bundle.db.select().from(auditEvents).all()),
    ).not.toContain(result.temporaryPassword);
    change("deactivate", row.id);
    expect(
      await verifyLocalCredentials(
        { email: row.email, password: result.temporaryPassword },
        bundle.db,
      ),
    ).toBeNull();
    await expect(
      createAccountWithTemporaryPassword(
        {
          ...actor,
          input: {
            displayName: "New Account",
            email: row.email,
            role: "reviewer",
            reason: "Retry",
          },
        },
        bundle,
      ),
    ).rejects.toThrow(/already exists/i);
    expect(
      bundle.db.select().from(users).where(eq(users.id, row.id)).get()
        ?.isActive,
    ).toBe(false);
  });

  it("expires a temporary password through mandatory first sign-in change", async () => {
    const result = await createAccountWithTemporaryPassword(
      {
        ...actor,
        input: {
          displayName: "New Account",
          email: "temp@example.com",
          role: "reviewer",
          reason: "New colleague",
        },
      },
      bundle,
    );
    bundle.db.insert(authSessions).values({
      id: "session-temp",
      userId: result.user.id,
      authSource: "local",
      authVersion: 1,
      status: "active",
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: "2099-01-01T00:00:00.000Z",
      absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
    }).run();

    await completeMandatoryPasswordChange(
      {
        actorUserId: result.user.id,
        actorAuthSessionId: "session-temp",
        password: "new-account-secret",
        confirmPassword: "new-account-secret",
      },
      bundle,
    );

    const row = bundle.db.select().from(users).where(eq(users.id, result.user.id)).get()!;
    expect(row.mustChangePassword).toBe(false);
    expect(await compare(result.temporaryPassword, row.passwordHash!)).toBe(false);
    expect(await compare("new-account-secret", row.passwordHash!)).toBe(true);
    expect(
      await verifyLocalCredentials(
        { email: "temp@example.com", password: result.temporaryPassword },
        bundle.db,
      ),
    ).toBeNull();
  });
});

it("records the initiator and revives only after valid sign-in following self-deactivation", async () => {
  const { hash } = await import("bcryptjs");
  bundle.db
    .update(users)
    .set({ passwordHash: await hash("test-secret-only", 4) })
    .where(eq(users.id, "target"))
    .run();
  const { deactivateOwnAccount } =
    await import("@/server/auth/account-lifecycle");
  deactivateOwnAccount(
    {
      actorUserId: "target",
      actorAuthSessionId: "session-target",
      reason: "Taking a break",
    },
    bundle,
  );
  expect(target()).toMatchObject({
    isActive: false,
    deactivatedByUserId: "target",
  });
  expect(
    await verifyLocalCredentials(
      { email: "target@example.com", password: "wrong" },
      bundle.db,
    ),
  ).toBeNull();
  expect(target().isActive).toBe(false);
  expect(
    await verifyLocalCredentials(
      { email: "target@example.com", password: "test-secret-only" },
      bundle.db,
    ),
  ).toMatchObject({ id: "target", isActive: true });
  expect(target()).toMatchObject({ isActive: true, deactivatedByUserId: null });
  expect(
    bundle.db
      .select()
      .from(auditEvents)
      .all()
      .map((event) => event.type),
  ).toEqual(["account.self_deactivated", "account.self_reactivated"]);
  change("deactivate");
  expect(target()).toMatchObject({
    isActive: false,
    deactivatedByUserId: "admin",
  });
  expect(
    await verifyLocalCredentials(
      { email: "target@example.com", password: "test-secret-only" },
      bundle.db,
    ),
  ).toBeNull();
});

it("does not let a stale self-service session bypass final-admin protection", async () => {
  const { deactivateOwnAccount } =
    await import("@/server/auth/account-lifecycle");
  expect(() =>
    deactivateOwnAccount({ ...actor, reason: "Taking a break" }, bundle),
  ).toThrow(/last active administrator/);
  bundle.db
    .update(authSessions)
    .set({ status: "revoked" })
    .where(eq(authSessions.id, "session-target"))
    .run();
  expect(() =>
    deactivateOwnAccount(
      {
        actorUserId: "target",
        actorAuthSessionId: "session-target",
        reason: "Taking a break",
      },
      bundle,
    ),
  ).toThrow(/session/i);
  expect(target().isActive).toBe(true);
});

it("operator offboarding overrides an earlier self-deactivation initiator", async () => {
  const { deactivateOwnAccount } =
    await import("@/server/auth/account-lifecycle");
  const { offboardLinkedUser } = await import("@/server/auth/identity-links");
  deactivateOwnAccount(
    {
      actorUserId: "target",
      actorAuthSessionId: "session-target",
      reason: "Taking a break",
    },
    bundle,
  );
  offboardLinkedUser(
    { userId: "target", actorUserId: "admin", changeReason: "Departure" },
    bundle.db,
  );
  expect(target()).toMatchObject({
    isActive: false,
    deactivatedByUserId: "admin",
  });
});

it("withholds deactivated accounts from assignable users", async () => {
  const { listAssignableUsers } = await import("@/server/access/service");
  change("deactivate");
  expect(
    listAssignableUsers(bundle.db).some((user) => user.id === "target"),
  ).toBe(false);
  change("reactivate", "target", false);
  expect(
    listAssignableUsers(bundle.db).some((user) => user.id === "target"),
  ).toBe(true);
});

it("administrator intervention during password verification prevents self-revival", async () => {
  const { hash } = await import("bcryptjs");
  const { deactivateOwnAccount } =
    await import("@/server/auth/account-lifecycle");
  const { offboardLinkedUser } = await import("@/server/auth/identity-links");
  bundle.db
    .update(users)
    .set({ passwordHash: await hash("test-secret-only", 4) })
    .where(eq(users.id, "target"))
    .run();
  deactivateOwnAccount(
    {
      actorUserId: "target",
      actorAuthSessionId: "session-target",
      reason: "Taking a break",
    },
    bundle,
  );
  const admission = verifyLocalCredentials(
    { email: "target@example.com", password: "test-secret-only" },
    bundle.db,
  );
  offboardLinkedUser(
    { userId: "target", actorUserId: "admin", changeReason: "Access revoked" },
    bundle.db,
  );
  expect(await admission).toBeNull();
  expect(target()).toMatchObject({
    isActive: false,
    deactivatedByUserId: "admin",
  });
});

it("revalidates the administrator after hashing a generated password", async () => {
  const creation = createAccountWithTemporaryPassword(
    {
      ...actor,
      input: {
        displayName: "New Account",
        email: "raced@example.com",
        role: "reviewer",
        reason: "New colleague",
      },
    },
    bundle,
  );
  bundle.db
    .update(authSessions)
    .set({ status: "revoked" })
    .where(eq(authSessions.id, "session-admin"))
    .run();
  await expect(creation).rejects.toThrow(/active administrator session/i);
  expect(
    bundle.db
      .select()
      .from(users)
      .where(eq(users.email, "raced@example.com"))
      .get(),
  ).toBeUndefined();
});

it("rolls back sign-in revival if the governance audit cannot be written", async () => {
  const { hash } = await import("bcryptjs");
  const { deactivateOwnAccount } =
    await import("@/server/auth/account-lifecycle");
  bundle.db
    .update(users)
    .set({ passwordHash: await hash("test-secret-only", 4) })
    .where(eq(users.id, "target"))
    .run();
  deactivateOwnAccount(
    {
      actorUserId: "target",
      actorAuthSessionId: "session-target",
      reason: "Taking a break",
    },
    bundle,
  );
  bundle.sqlite.exec(
    "CREATE TRIGGER fail_revival_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  await expect(
    verifyLocalCredentials(
      { email: "target@example.com", password: "test-secret-only" },
      bundle.db,
    ),
  ).rejects.toThrow();
  expect(target()).toMatchObject({
    isActive: false,
    deactivatedByUserId: "target",
  });
});
