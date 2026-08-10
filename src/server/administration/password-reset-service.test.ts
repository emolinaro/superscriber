import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminPasswordResetServiceError,
  adminIssuePasswordReset,
} from "@/server/administration/password-reset-service";
import {
  issueResetToken,
  loadRedeemableToken,
} from "@/server/auth/password-reset-tokens";
import { openAppDatabase } from "@/server/db/client";

const NOW = "2026-08-10T12:00:00.000Z";
const ACTIVE_SESSION_EXPIRY = "2099-01-01T00:00:00.000Z";
const ADMIN_SESSION_ID = "auth-session-admin-1";
type Bundle = ReturnType<typeof openAppDatabase>;

function insertUser(
  bundle: Bundle,
  input: {
    id: string;
    role?: "uploader" | "reviewer" | "approver" | "admin";
    active?: boolean;
    passwordHash?: string | null;
  },
) {
  bundle.sqlite
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, auth_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      input.id,
      `${input.id}@example.com`,
      input.id,
      input.passwordHash === undefined ? "hash" : input.passwordHash,
      input.role ?? "reviewer",
      input.active ?? true ? 1 : 0,
      NOW,
      NOW,
    );
}

function insertAuthSession(bundle: Bundle, input: { id: string; userId: string }) {
  bundle.sqlite
    .prepare(
      `INSERT INTO auth_sessions (id, user_id, auth_source, auth_version, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, 'local', 1, 'active', ?, ?, ?, ?)`,
    )
    .run(input.id, input.userId, NOW, NOW, ACTIVE_SESSION_EXPIRY, ACTIVE_SESSION_EXPIRY);
}

function setup() {
  const bundle = openAppDatabase(":memory:");
  bundle.sqlite
    .prepare(`INSERT INTO workspaces (id, name, slug, policy_profile_id) VALUES ('workspace-1', 'Test workspace', 'test-workspace', 'strict')`)
    .run();
  insertUser(bundle, { id: "admin-1", role: "admin" });
  insertAuthSession(bundle, { id: ADMIN_SESSION_ID, userId: "admin-1" });
  insertUser(bundle, { id: "reviewer-1" });
  return bundle;
}

const INPUT = {
  userId: "reviewer-1",
  reason: "User forgot their password at the front desk.",
  delivery: "operator_handoff" as const,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("adminIssuePasswordReset", () => {
  it("issues a handoff reset: sessions retired, prior tokens invalidated, audit plus security events written", () => {
    const bundle = setup();
    const prior = issueResetToken(
      { userId: "reviewer-1", source: "self_service", delivery: "email" },
      bundle.db,
    );
    insertAuthSession(bundle, { id: "s1", userId: "reviewer-1" });

    const result = adminIssuePasswordReset(
      { actorUserId: "admin-1", actorAuthSessionId: ADMIN_SESSION_ID, input: INPUT },
      bundle,
    );

    expect(result.revokedSessionCount).toBe(1);
    expect(result.resultingAuthVersion).toBe(2);
    expect(result.rawToken).toBeTruthy();
    expect(result.actorMustRelogin).toBe(false);
    expect(loadRedeemableToken(prior.rawToken, bundle.db)).toEqual({
      ok: false,
      reason: "invalidated",
    });
    expect(loadRedeemableToken(result.rawToken, bundle.db).ok).toBe(true);

    const audit = bundle.sqlite
      .prepare(`SELECT type, actor_user_id AS actorUserId FROM audit_events ORDER BY created_at DESC LIMIT 1`)
      .get() as { type: string; actorUserId: string };
    expect(audit.type).toBe("account.password_reset");
    expect(audit.actorUserId).toBe("admin-1");

    const issued = bundle.sqlite
      .prepare(`SELECT type, outcome, user_id AS userId FROM security_events WHERE type = 'admin.password_reset.issued'`)
      .get() as { type: string; outcome: string; userId: string } | undefined;
    expect(issued).toMatchObject({ outcome: "success", userId: "reviewer-1" });
    expect(JSON.stringify(issued)).not.toContain(result.rawToken);
    expect(JSON.stringify(issued)).not.toContain("@example.com");
  });

  it("denies inactive, designee, disabled-credential, and unknown targets", () => {
    const bundle = setup();
    insertUser(bundle, { id: "inactive-1", active: false });
    insertUser(bundle, { id: "retired-1", passwordHash: "disabled:abc" });
    insertUser(bundle, { id: "designee-1", role: "admin" });
    bundle.sqlite
      .prepare(`INSERT INTO auth_control (id, break_glass_user_id, updated_at, updated_by_user_id, change_reason) VALUES (1, 'designee-1', ?, NULL, 'test designation reason')`)
      .run(NOW);

    const cases: Array<[string, string]> = [
      ["inactive-1", "INACTIVE_TARGET"],
      ["designee-1", "BREAK_GLASS_DESIGNEE"],
      ["retired-1", "CREDENTIAL_DISABLED"],
      ["missing", "NOT_FOUND"],
    ];
    for (const [userId, code] of cases) {
      try {
        adminIssuePasswordReset(
          {
            actorUserId: "admin-1",
            actorAuthSessionId: ADMIN_SESSION_ID,
            input: { ...INPUT, userId },
          },
          bundle,
        );
        throw new Error(`expected ${code} denial`);
      } catch (error) {
        expect(error).toBeInstanceOf(AdminPasswordResetServiceError);
        expect((error as AdminPasswordResetServiceError).failure.code).toBe(code);
      }
    }

    // Denials record the denied attempt; no tokens were created.
    const tokens = bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all();
    expect(tokens).toHaveLength(0);
    const denials = bundle.sqlite
      .prepare(`SELECT outcome FROM security_events WHERE type = 'admin.password_reset.issued'`)
      .all() as Array<{ outcome: string }>;
    expect(denials).toHaveLength(4);
    expect(denials.every((d) => d.outcome === "denied")).toBe(true);
  });

  it("denies email delivery when the mail seam is unconfigured", () => {
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_MODE", "");
    const bundle = setup();

    expect(() =>
      adminIssuePasswordReset(
        {
          actorUserId: "admin-1",
          actorAuthSessionId: ADMIN_SESSION_ID,
          input: { ...INPUT, delivery: "email" },
        },
        bundle,
      ),
    ).toThrow(AdminPasswordResetServiceError);
    expect(bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all()).toHaveLength(0);
  });

  it("allows email delivery when the seam is configured", () => {
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_MODE", "smtp");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_SMTP_HOST", "mail.example.test");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_SMTP_PORT", "587");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS", "reset@example.test");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE", "/run/secrets/pw");
    const bundle = setup();

    const result = adminIssuePasswordReset(
      {
        actorUserId: "admin-1",
        actorAuthSessionId: ADMIN_SESSION_ID,
        input: { ...INPUT, delivery: "email" },
      },
      bundle,
    );
    expect(result.delivery).toBe("email");
  });

  it("self-reset retires the actor's own session and flags actorMustRelogin", () => {
    const bundle = setup();

    const result = adminIssuePasswordReset(
      {
        actorUserId: "admin-1",
        actorAuthSessionId: ADMIN_SESSION_ID,
        input: { ...INPUT, userId: "admin-1" },
      },
      bundle,
    );

    expect(result.actorMustRelogin).toBe(true);
    const session = bundle.sqlite
      .prepare(`SELECT status FROM auth_sessions WHERE id = ?`)
      .get(ADMIN_SESSION_ID) as { status: string };
    expect(session.status).toBe("revoked");
  });

  it("denies a lapsed admin session", () => {
    const bundle = setup();
    bundle.sqlite
      .prepare(`UPDATE auth_sessions SET status = 'revoked' WHERE id = ?`)
      .run(ADMIN_SESSION_ID);

    expect(() =>
      adminIssuePasswordReset(
        { actorUserId: "admin-1", actorAuthSessionId: ADMIN_SESSION_ID, input: INPUT },
        bundle,
      ),
    ).toThrow(AdminPasswordResetServiceError);
  });
});
