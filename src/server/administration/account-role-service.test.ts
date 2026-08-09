import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthSession } from "@/server/auth/session-registry";
import {
  AccountRoleChangeServiceError,
  changeAccountRole,
} from "@/server/administration/account-role-service";
import { openAppDatabase } from "@/server/db/client";
import {
  appStateMeta,
  authControl,
  authSessions,
  auditEvents,
  externalIdentities,
  recordingAssignments,
  recordings,
  securityEvents,
  users,
  workspaces,
} from "@/server/db/schema";

const NOW = "2026-08-08T12:00:00.000Z";
const ACTIVE_SESSION_EXPIRY = "2099-01-01T00:00:00.000Z";
const ADMIN_1_SESSION_ID = "auth-session-admin-1";
const ADMIN_2_SESSION_ID = "auth-session-admin-2";
type Bundle = ReturnType<typeof openAppDatabase>;

function insertUser(
  bundle: Bundle,
  input: {
    id: string;
    role: "uploader" | "reviewer" | "approver" | "admin";
    active?: boolean;
    displayName?: string;
  },
) {
  bundle.db.insert(users).values({
    id: input.id,
    email: `${input.id}@example.com`,
    displayName: input.displayName ?? input.id,
    passwordHash: "hash",
    role: input.role,
    isActive: input.active ?? true,
    authVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }).run();
}

function insertAuthSession(
  bundle: Bundle,
  input: {
    id: string;
    userId: string;
    status?: "active" | "revoked" | "expired";
    authVersion?: number;
  },
) {
  bundle.db.insert(authSessions).values({
    id: input.id,
    userId: input.userId,
    authSource: "local",
    authVersion: input.authVersion ?? 1,
    providerSid: null,
    externalIdentityId: null,
    status: input.status ?? "active",
    createdAt: NOW,
    lastSeenAt: NOW,
    idleExpiresAt: ACTIVE_SESSION_EXPIRY,
    absoluteExpiresAt: ACTIVE_SESSION_EXPIRY,
    revokedAt: input.status === "revoked" ? NOW : null,
    revokedReason: input.status === "revoked" ? "test" : null,
    emergencyActivationId: null,
  }).run();
}

function setup(options: { secondAdmin?: boolean } = {}) {
  const bundle = openAppDatabase(":memory:");
  bundle.db.insert(workspaces).values({
    id: "workspace-1",
    name: "Test workspace",
    slug: "test-workspace",
    policyProfileId: "strict",
  }).run();
  insertUser(bundle, {
    id: "admin-1",
    role: "admin",
    displayName: "Admin One",
  });
  insertAuthSession(bundle, {
    id: ADMIN_1_SESSION_ID,
    userId: "admin-1",
  });
  if (options.secondAdmin ?? true) {
    insertUser(bundle, {
      id: "admin-2",
      role: "admin",
      displayName: "Admin Two",
    });
    insertAuthSession(bundle, {
      id: ADMIN_2_SESSION_ID,
      userId: "admin-2",
    });
  }
  insertUser(bundle, {
    id: "target-1",
    role: "reviewer",
    displayName: "Target One",
  });
  return bundle;
}

function roleInput(
  overrides: Partial<{
    userId: string;
    expectedRole: "uploader" | "reviewer" | "approver" | "admin";
    newRole: "uploader" | "reviewer" | "approver" | "admin";
    reason: string;
  }> = {},
) {
  return {
    userId: "target-1",
    expectedRole: "reviewer" as const,
    newRole: "approver" as const,
    reason: "Operational duties changed.",
    ...overrides,
  };
}

function failure(
  run: () => unknown,
  code:
    | "ACCESS_DENIED"
    | "NOT_FOUND"
    | "VALIDATION_ERROR"
    | "STATE_CHANGED"
    | "BREAK_GLASS_PROTECTED"
    | "LAST_ACTIVE_ADMIN"
    | "ASSIGNMENTS_INCOMPATIBLE"
    | "INTERNAL_ERROR",
) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccountRoleChangeServiceError);
    const typed = error as AccountRoleChangeServiceError;
    expect(typed.failure.code).toBe(code);
    return typed.failure;
  }
  throw new Error(`Expected ${code}.`);
}

function insertRecording(bundle: Bundle, id: string, title: string) {
  bundle.db.insert(recordings).values({
    id,
    workspaceId: "workspace-1",
    title,
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: `${id}.wav`,
    languageHint: "english",
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: null,
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Ready",
    createdAt: NOW,
    updatedAt: NOW,
    automationCursor: null,
  }).run();
}

function insertAssignment(
  bundle: Bundle,
  input: {
    id: string;
    recordingId: string;
    role: "reviewer" | "approver";
    status?: "active" | "completed" | "removed";
  },
) {
  const status = input.status ?? "active";
  bundle.db.insert(recordingAssignments).values({
    id: input.id,
    recordingId: input.recordingId,
    userId: "target-1",
    assignedByUserId: "admin-1",
    assignmentRole: input.role,
    status,
    isActive: status === "active",
    createdAt: NOW,
    updatedAt: NOW,
    endedAt: status === "active" ? null : NOW,
    endReason: status === "removed" ? "removed_by_admin" : null,
    completedRevisionId: null,
    removedByUserId: status === "removed" ? "admin-1" : null,
  }).run();
}

function governedSnapshot(bundle: Bundle) {
  const target = bundle.db
    .select({ role: users.role, authVersion: users.authVersion })
    .from(users)
    .where(eq(users.id, "target-1"))
    .get();
  const sessions = bundle.db
    .select({
      id: authSessions.id,
      status: authSessions.status,
      revokedAt: authSessions.revokedAt,
      revokedReason: authSessions.revokedReason,
    })
    .from(authSessions)
    .where(eq(authSessions.userId, "target-1"))
    .all();
  return {
    target,
    sessions,
    auditCount: bundle.db.select().from(auditEvents).all().length,
    securityCount: bundle.db.select().from(securityEvents).all().length,
    stateVersion: bundle.db.select().from(appStateMeta).get()?.stateVersion,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("changeAccountRole", () => {
  it("atomically changes role, audits, increments authorization, revokes every session, and preserves identity links", () => {
    const bundle = setup();
    bundle.db.insert(externalIdentities).values({
      id: "identity-1",
      userId: "target-1",
      issuer: "https://issuer.example/",
      subject: "subject-1",
      status: "active",
      linkedAt: NOW,
      linkedByUserId: "admin-1",
      retiredAt: null,
      retiredByUserId: null,
      changeReason: "Provisioned for test.",
      lastLoginAt: null,
      lastRoleMapVersion: 1,
    }).run();
    const identityBefore = bundle.db.select().from(externalIdentities).get();
    for (const [index, source] of ["local", "authentik", "break_glass"].entries()) {
      createAuthSession(
        {
          userId: "target-1",
          authSource: source as "local" | "authentik" | "break_glass",
          now: new Date(Date.parse(NOW) + index * 1_000),
        },
        bundle.db,
      );
    }

    const result = changeAccountRole(
      {
        actorUserId: "admin-1",
        actorAuthSessionId: ADMIN_1_SESSION_ID,
        input: roleInput({ reason: "  Operational duties changed.  " }),
      },
      bundle,
    );

    expect(result).toMatchObject({
      oldRole: "reviewer",
      newRole: "approver",
      revokedSessionCount: 3,
      actorMustRelogin: false,
      resultingAuthVersion: 2,
      user: { id: "target-1", role: "approver" },
    });
    expect(
      bundle.db
        .select({ role: users.role, authVersion: users.authVersion })
        .from(users)
        .where(eq(users.id, "target-1"))
        .get(),
    ).toEqual({ role: "approver", authVersion: 2 });
    const revoked = bundle.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, "target-1"))
      .all();
    expect(revoked).toHaveLength(3);
    expect(
      revoked.every(
        (row) =>
          row.status === "revoked" &&
          row.revokedReason === "account_role_changed" &&
          row.revokedAt === revoked[0]?.revokedAt,
      ),
    ).toBe(true);
    expect(bundle.db.select().from(externalIdentities).get()).toEqual(identityBefore);
    expect(bundle.db.select().from(appStateMeta).get()?.stateVersion).toBe(1);

    const events = bundle.db.select().from(auditEvents).all();
    expect(events).toHaveLength(1);
    const metadata = JSON.parse(events[0]!.metadata) as {
      version: number;
      data: Record<string, unknown>;
    };
    expect(events[0]).toMatchObject({
      workspaceId: "workspace-1",
      recordingId: null,
      actorRole: "admin",
      actorUserId: "admin-1",
      actorDisplayName: "Admin One",
      effectiveRole: "admin",
      type: "account.role_changed",
    });
    expect(metadata).toEqual({
      version: 1,
      data: {
        targetUserId: "target-1",
        targetDisplayName: "Target One",
        oldRole: "reviewer",
        newRole: "approver",
        reason: "Operational duties changed.",
        resultingAuthVersion: 2,
        revokedSessionCount: 3,
      },
    });
    expect(events[0]!.createdAt).toBe(revoked[0]!.revokedAt);
    expect(
      bundle.db
        .select({ metadata: securityEvents.metadata })
        .from(securityEvents)
        .all()
        .some((row) => row.metadata.includes("Operational duties changed")),
    ).toBe(false);
    bundle.sqlite.close();
  });

  it("allows self-demotion when another active administrator remains and preserves admin attribution", () => {
    const bundle = setup();

    const result = changeAccountRole(
      {
        actorUserId: "admin-1",
        actorAuthSessionId: ADMIN_1_SESSION_ID,
        input: roleInput({
          userId: "admin-1",
          expectedRole: "admin",
          newRole: "reviewer",
        }),
      },
      bundle,
    );

    expect(result.actorMustRelogin).toBe(true);
    expect(result.user.role).toBe("reviewer");
    expect(bundle.db.select().from(auditEvents).get()).toMatchObject({
      actorUserId: "admin-1",
      actorRole: "admin",
      effectiveRole: "admin",
    });
    bundle.sqlite.close();
  });

  it("rejects final-admin self-demotion without governed writes", () => {
    const bundle = setup({ secondAdmin: false });
    const before = governedSnapshot(bundle);

    const denied = failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput({
              userId: "admin-1",
              expectedRole: "admin",
              newRole: "reviewer",
            }),
          },
          bundle,
        ),
      "LAST_ACTIVE_ADMIN",
    );

    expect(denied.message).toContain("At least one active administrator must remain");
    const after = governedSnapshot(bundle);
    expect(after.target).toEqual(before.target);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.auditCount).toBe(before.auditCount);
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(bundle.db.select().from(securityEvents).all()).toContainEqual(
      expect.objectContaining({
        type: "account.role_change.denied",
        outcome: "denied",
        userId: "admin-1",
      }),
    );
    bundle.sqlite.close();
  });

  it("rejects a break-glass demotion, then permits the old custodian after transfer", () => {
    const bundle = setup();
    bundle.db.update(users).set({ role: "admin" }).where(eq(users.id, "target-1")).run();
    bundle.db.insert(authControl).values({
      id: 1,
      breakGlassUserId: "target-1",
      updatedAt: NOW,
      updatedByUserId: "admin-1",
      changeReason: "Initial custodian.",
    }).run();

    failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput({ expectedRole: "admin", newRole: "reviewer" }),
          },
          bundle,
        ),
      "BREAK_GLASS_PROTECTED",
    );

    bundle.db.update(authControl).set({
      breakGlassUserId: "admin-2",
      updatedAt: NOW,
      updatedByUserId: "admin-1",
      changeReason: "Transferred for role change.",
    }).where(eq(authControl.id, 1)).run();
    expect(
      changeAccountRole(
        {
          actorUserId: "admin-1",
          actorAuthSessionId: ADMIN_1_SESSION_ID,
          input: roleInput({ expectedRole: "admin", newRole: "reviewer" }),
        },
        bundle,
      ).newRole,
    ).toBe("reviewer");
    bundle.sqlite.close();
  });

  it("returns grouped active assignment blockers and ignores historical assignments", () => {
    const bundle = setup();
    for (const [index, title] of ["Zulu", "Alpha", "Charlie", "Bravo"].entries()) {
      const recordingId = `rec-${index}`;
      insertRecording(bundle, recordingId, title);
      insertAssignment(bundle, {
        id: `assignment-${index}`,
        recordingId,
        role: "reviewer",
      });
    }
    insertRecording(bundle, "rec-history", "Historical");
    insertAssignment(bundle, {
      id: "assignment-history",
      recordingId: "rec-history",
      role: "reviewer",
      status: "removed",
    });

    const denied = failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput({ newRole: "admin" }),
          },
          bundle,
        ),
      "ASSIGNMENTS_INCOMPATIBLE",
    );

    expect(denied.assignmentBlockers).toEqual({
      total: 4,
      byRole: [
        {
          role: "reviewer",
          count: 4,
          recordingTitles: ["Alpha", "Bravo", "Charlie"],
        },
      ],
      managementHref:
        "/administration?section=assignments&status=active&userId=target-1",
    });
    expect(denied.message).toContain("to Admin.");
    bundle.sqlite.close();
  });

  it.each([
    { currentRole: "reviewer", newRole: "uploader" },
    { currentRole: "reviewer", newRole: "approver" },
    { currentRole: "reviewer", newRole: "admin" },
    { currentRole: "approver", newRole: "uploader" },
    { currentRole: "approver", newRole: "reviewer" },
    { currentRole: "approver", newRole: "admin" },
  ] as const)(
    "blocks an active $currentRole assignment when changing to $newRole",
    ({ currentRole, newRole }) => {
      const bundle = setup();
      if (currentRole === "approver") {
        bundle.db
          .update(users)
          .set({ role: "approver" })
          .where(eq(users.id, "target-1"))
          .run();
      }
      insertRecording(bundle, "rec-blocker-matrix", "Blocker matrix");
      insertAssignment(bundle, {
        id: "assignment-blocker-matrix",
        recordingId: "rec-blocker-matrix",
        role: currentRole,
      });

      failure(
        () =>
          changeAccountRole(
            {
              actorUserId: "admin-1",
              actorAuthSessionId: ADMIN_1_SESSION_ID,
              input: roleInput({ expectedRole: currentRole, newRole }),
            },
            bundle,
          ),
        "ASSIGNMENTS_INCOMPATIBLE",
      );
      bundle.sqlite.close();
    },
  );

  it("allows a pre-v8 mismatch to be repaired toward the active assignment role", () => {
    const bundle = setup();
    bundle.sqlite.exec("DROP TRIGGER recording_assignments_role_guard_insert");
    bundle.db.update(users).set({ role: "uploader" }).where(eq(users.id, "target-1")).run();
    insertRecording(bundle, "rec-repair", "Repair recording");
    insertAssignment(bundle, {
      id: "assignment-repair",
      recordingId: "rec-repair",
      role: "reviewer",
    });

    const result = changeAccountRole(
      {
        actorUserId: "admin-1",
        actorAuthSessionId: ADMIN_1_SESSION_ID,
        input: roleInput({ expectedRole: "uploader", newRole: "reviewer" }),
      },
      bundle,
    );

    expect(result.newRole).toBe("reviewer");
    bundle.sqlite.close();
  });

  it("rejects missing, stale, invalid, inactive, and non-admin authority", () => {
    const bundle = setup();

    failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput({ userId: "missing" }),
          },
          bundle,
        ),
      "NOT_FOUND",
    );
    bundle.db.update(users).set({ role: "approver" }).where(eq(users.id, "target-1")).run();
    const stale = failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput(),
          },
          bundle,
        ),
      "STATE_CHANGED",
    );
    expect(stale.currentRole).toBe("approver");
    bundle.db.update(users).set({ role: "reviewer" }).where(eq(users.id, "target-1")).run();
    bundle.db.update(users).set({ role: "reviewer" }).where(eq(users.id, "admin-1")).run();
    failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput(),
          },
          bundle,
        ),
      "ACCESS_DENIED",
    );
    bundle.db.update(users).set({ role: "admin", isActive: false }).where(eq(users.id, "admin-1")).run();
    failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput(),
          },
          bundle,
        ),
      "ACCESS_DENIED",
    );
    failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-2",
            actorAuthSessionId: ADMIN_2_SESSION_ID,
            input: roleInput({ reason: "short" }),
          },
          bundle,
        ),
      "VALIDATION_ERROR",
    );
    bundle.sqlite.close();
  });

  it.each([
    {
      label: "revoked",
      prepare: (bundle: Bundle) => {
        bundle.db
          .update(authSessions)
          .set({
            status: "revoked",
            revokedAt: NOW,
            revokedReason: "test",
          })
          .where(eq(authSessions.id, ADMIN_1_SESSION_ID))
          .run();
      },
    },
    {
      label: "auth-version-stale",
      prepare: (bundle: Bundle) => {
        bundle.db
          .update(users)
          .set({ authVersion: 2 })
          .where(eq(users.id, "admin-1"))
          .run();
      },
    },
  ])("rejects $label actor authority before governed writes", ({ prepare }) => {
    const bundle = setup();
    const before = governedSnapshot(bundle);
    prepare(bundle);

    failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput(),
          },
          bundle,
        ),
      "ACCESS_DENIED",
    );

    const after = governedSnapshot(bundle);
    expect(after.target).toEqual(before.target);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.auditCount).toBe(before.auditCount);
    expect(after.stateVersion).toBe(before.stateVersion);
    bundle.sqlite.close();
  });

  it("allows changing an inactive target and does not count it for final-admin protection", () => {
    const bundle = setup();
    bundle.db
      .update(users)
      .set({ role: "admin", isActive: false })
      .where(eq(users.id, "target-1"))
      .run();

    const result = changeAccountRole(
      {
        actorUserId: "admin-1",
        actorAuthSessionId: ADMIN_1_SESSION_ID,
        input: roleInput({ expectedRole: "admin", newRole: "uploader" }),
      },
      bundle,
    );

    expect(result.user).toMatchObject({ role: "uploader", isActive: false });
    bundle.sqlite.close();
  });

  it("lets one compare-and-set win and returns current role to the stale loser", () => {
    const bundle = setup();

    expect(
      changeAccountRole(
        {
          actorUserId: "admin-1",
          actorAuthSessionId: ADMIN_1_SESSION_ID,
          input: roleInput({ newRole: "approver" }),
        },
        bundle,
      ).newRole,
    ).toBe("approver");
    const loser = failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput({ newRole: "uploader" }),
          },
          bundle,
        ),
      "STATE_CHANGED",
    );
    expect(loser.currentRole).toBe("approver");
    expect(bundle.db.select().from(auditEvents).all()).toHaveLength(1);
    bundle.sqlite.close();
  });

  it.each([
    {
      label: "audit insertion",
      trigger: `CREATE TRIGGER abort_role_audit BEFORE INSERT ON audit_events
        WHEN NEW.type = 'account.role_changed'
        BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`,
    },
    {
      label: "session update",
      trigger: `CREATE TRIGGER abort_role_session BEFORE UPDATE ON auth_sessions
        WHEN NEW.revoked_reason = 'account_role_changed'
        BEGIN SELECT RAISE(ABORT, 'session update unavailable'); END;`,
    },
    {
      label: "state version",
      trigger: `CREATE TRIGGER abort_role_state BEFORE UPDATE ON app_state_meta
        BEGIN SELECT RAISE(ABORT, 'state version unavailable'); END;`,
    },
  ])("rolls back every governed write when $label fails", ({ trigger }) => {
    const bundle = setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    createAuthSession(
      { userId: "target-1", authSource: "local", now: new Date(NOW) },
      bundle.db,
    );
    const before = governedSnapshot(bundle);
    bundle.sqlite.exec(trigger);

    failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput(),
          },
          bundle,
        ),
      "INTERNAL_ERROR",
    );

    expect(governedSnapshot(bundle)).toEqual(before);
    bundle.sqlite.close();
  });

  it("keeps the typed denial when denial diagnostics fail and redacts the reason", () => {
    const bundle = setup({ secondAdmin: false });
    bundle.sqlite.exec(`
      CREATE TRIGGER abort_role_denial
      BEFORE INSERT ON security_events
      WHEN NEW.type = 'account.role_change.denied'
      BEGIN SELECT RAISE(ABORT, 'diagnostics unavailable'); END;
    `);

    const denied = failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput({
              userId: "admin-1",
              expectedRole: "admin",
              newRole: "reviewer",
              reason: "Sensitive governance reason.",
            }),
          },
          bundle,
        ),
      "LAST_ACTIVE_ADMIN",
    );

    expect(denied.message).toContain("At least one active administrator");
    expect(JSON.stringify(bundle.db.select().from(securityEvents).all())).not.toContain(
      "Sensitive governance reason",
    );
    bundle.sqlite.close();
  });

  it("returns a safe correlation id and logs only identifiers and stage on unexpected failure", () => {
    const bundle = setup();
    bundle.db.delete(workspaces).run();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const denied = failure(
      () =>
        changeAccountRole(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_1_SESSION_ID,
            input: roleInput(),
          },
          bundle,
        ),
      "INTERNAL_ERROR",
    );

    expect(denied.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(denied.message).not.toContain("workspace");
    expect(consoleError).toHaveBeenCalledWith(
      "account role change failed",
      expect.objectContaining({
        correlationId: denied.correlationId,
        actorUserId: "admin-1",
        targetUserId: "target-1",
        stage: "workspace",
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "Operational duties changed",
    );
    bundle.sqlite.close();
  });
});
