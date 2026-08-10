import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/reset-mailer", () => ({
  sendPasswordResetEmail: vi.fn(async () => ({})),
}));

import { sendPasswordResetEmail } from "@/server/auth/reset-mailer";
import { PASSWORD_RESET_COPY } from "@/lib/password-reset";
import { completePasswordReset, requestPasswordReset } from "@/server/auth/password-reset";
import {
  resetRedeemByIpLimiter,
  resetRequestByEmailLimiter,
  resetRequestByIpLimiter,
} from "@/server/auth/password-reset-rate-limit";
import { issueResetToken } from "@/server/auth/password-reset-tokens";
import { openAppDatabase } from "@/server/db/client";

const T0 = "2026-08-10T12:00:00.000Z";

const SMTP_ENV = {
  SUPERSCRIBER_RESET_MAIL_MODE: "smtp",
  SUPERSCRIBER_RESET_MAIL_SMTP_HOST: "mail.example.test",
  SUPERSCRIBER_RESET_MAIL_SMTP_PORT: "587",
  SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS: "reset@example.test",
  SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE: "/run/secrets/reset-mail-password",
};

function seedUser(sqlite: import("better-sqlite3").Database, id: string) {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', 'reviewer', 1, ?, ?)`,
    )
    .run(id, `${id}@example.com`, id, T0, T0);
}

function securityEventRows(sqlite: import("better-sqlite3").Database) {
  return sqlite
    .prepare(
      `SELECT type, outcome, user_id AS userId, detail, metadata FROM security_events ORDER BY created_at`,
    )
    .all() as Array<{
    type: string;
    outcome: string;
    userId: string | null;
    detail: string;
    metadata: string;
  }>;
}

beforeEach(() => {
  resetRequestByIpLimiter.reset();
  resetRequestByEmailLimiter.reset();
  resetRedeemByIpLimiter.reset();
  vi.mocked(sendPasswordResetEmail).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requestPasswordReset", () => {
  it("records accepted-unconfigured and sends nothing when mail is off", async () => {
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_MODE", "");
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");

    await requestPasswordReset(
      { email: "  User-1@Example.com ", ip: "127.0.0.1", origin: "https://app.test" },
      bundle.db,
    );

    expect(bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all()).toHaveLength(0);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(securityEventRows(bundle.sqlite)).toEqual([
      expect.objectContaining({
        type: "password.reset.requested",
        outcome: "success",
        userId: "user-1",
      }),
    ]);
    expect(securityEventRows(bundle.sqlite)[0]!.metadata).toContain("unconfigured");
  });

  it("treats unknown emails identically and records a denial without the address", async () => {
    const bundle = openAppDatabase(":memory:");

    await requestPasswordReset(
      { email: "ghost@example.com", ip: "127.0.0.1", origin: null },
      bundle.db,
    );

    const events = securityEventRows(bundle.sqlite);
    expect(events[0]).toMatchObject({
      type: "password.reset.requested",
      outcome: "denied",
      userId: null,
    });
    expect(JSON.stringify(events[0])).not.toContain("ghost@example.com");
  });

  it("rate limits per email after 3 requests per hour without revealing the limit", async () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");

    for (let i = 0; i < 4; i++) {
      await requestPasswordReset({ email: "user-1@example.com", ip: "127.0.0.1", origin: null }, bundle.db);
    }

    const events = securityEventRows(bundle.sqlite);
    expect(events.at(-1)).toMatchObject({ outcome: "denied" });
    expect(events.at(-1)!.metadata).toContain("rate_limited");
  });

  it("with smtp configured, issues a token and sends exactly one message", async () => {
    for (const [key, value] of Object.entries(SMTP_ENV)) vi.stubEnv(key, value);
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");

    await requestPasswordReset(
      { email: "user-1@example.com", ip: "127.0.0.1", origin: "https://app.test" },
      bundle.db,
    );

    expect(bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all()).toHaveLength(1);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [, message] = vi.mocked(sendPasswordResetEmail).mock.calls[0]!;
    expect(message.to).toBe("user-1@example.com");
    expect(message.resetUrl).toMatch(/^https:\/\/app\.test\/reset\//);
  });

  it("treats a malformed mail seam as unavailable and records an error event", async () => {
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_MODE", "smtp");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_SMTP_HOST", "");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_SMTP_PORT", "");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS", "");
    vi.stubEnv("SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE", "");
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");

    await requestPasswordReset(
      { email: "user-1@example.com", ip: "127.0.0.1", origin: null },
      bundle.db,
    );

    expect(bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all()).toHaveLength(0);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(securityEventRows(bundle.sqlite)[0]).toMatchObject({
      type: "password.reset.requested",
      outcome: "error",
      userId: "user-1",
    });
  });

  it("send failure records mail_failed and keeps the token valid", async () => {
    for (const [key, value] of Object.entries(SMTP_ENV)) vi.stubEnv(key, value);
    vi.mocked(sendPasswordResetEmail).mockRejectedValueOnce(new Error("smtp down"));
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");

    await requestPasswordReset({ email: "user-1@example.com", ip: "127.0.0.1", origin: null }, bundle.db);

    const tokens = bundle.sqlite.prepare(`SELECT * FROM password_reset_tokens`).all() as Array<{
      used_at: string | null;
      invalidated_at: string | null;
    }>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ used_at: null, invalidated_at: null });
    expect(securityEventRows(bundle.sqlite).map((e) => e.type)).toContain(
      "password.reset.mail_failed",
    );
  });
});

describe("completePasswordReset", () => {
  function insertAuthSession(
    bundle: ReturnType<typeof openAppDatabase>,
    input: { id: string; userId: string; authSource?: "local" | "authentik" | "break_glass" },
  ) {
    bundle.sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, user_id, auth_source, auth_version, provider_sid, external_identity_id, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revoked_reason, emergency_activation_id)
         VALUES (?, ?, ?, 1, NULL, NULL, 'active', ?, ?, '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', NULL, NULL, NULL)`,
      )
      .run(input.id, input.userId, input.authSource ?? "local", T0, T0);
  }

  it("rewrites the hash, bumps auth_version, and revokes every session source", async () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    insertAuthSession(bundle, { id: "s-local", userId: "user-1" });
    insertAuthSession(bundle, { id: "s-oidc", userId: "user-1", authSource: "authentik" });
    insertAuthSession(bundle, { id: "s-bg", userId: "user-1", authSource: "break_glass" });
    const issued = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
    );

    const result = await completePasswordReset(
      { rawToken: issued.rawToken, password: "NewPassword!234", ip: "127.0.0.1" },
      bundle,
    );

    expect(result).toEqual({ ok: true });
    const user = bundle.sqlite
      .prepare(`SELECT auth_version AS authVersion, password_hash AS passwordHash FROM users WHERE id = 'user-1'`)
      .get() as { authVersion: number; passwordHash: string };
    expect(user.authVersion).toBe(2);
    const sessions = bundle.sqlite
      .prepare(`SELECT status, revoked_reason AS revokedReason FROM auth_sessions WHERE user_id = 'user-1'`)
      .all() as Array<{ status: string; revokedReason: string }>;
    expect(sessions).toHaveLength(3);
    expect(
      sessions.every((s) => s.status === "revoked" && s.revokedReason === "password_reset"),
    ).toBe(true);
    const events = securityEventRows(bundle.sqlite);
    expect(events.map((e) => e.type)).toContain("password.reset.completed");
    expect(events.map((e) => e.type).filter((t) => t === "auth.session.revoked")).toHaveLength(3);
  });

  it("denies superseded, used, and unknown tokens with one generic result", async () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    const first = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
    );
    const second = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
    );

    const superseded = await completePasswordReset(
      { rawToken: first.rawToken, password: "WhateverPass1!", ip: "10.1.1.1" },
      bundle,
    );
    expect(superseded).toEqual({ ok: false, message: PASSWORD_RESET_COPY.REDEEM_FAILURE });

    await completePasswordReset(
      { rawToken: second.rawToken, password: "WhateverPass1!", ip: "10.1.1.1" },
      bundle,
    );
    const reused = await completePasswordReset(
      { rawToken: second.rawToken, password: "AnotherPass1!", ip: "10.1.1.1" },
      bundle,
    );
    expect(reused).toEqual({ ok: false, message: PASSWORD_RESET_COPY.REDEEM_FAILURE });

    const unknown = await completePasswordReset(
      { rawToken: "guessed-token", password: "AnotherPass1!", ip: "10.1.1.1" },
      bundle,
    );
    expect(unknown).toEqual({ ok: false, message: PASSWORD_RESET_COPY.REDEEM_FAILURE });

    const denials = securityEventRows(bundle.sqlite).filter(
      (e) => e.type === "password.reset.redeem_denied",
    );
    expect(denials).toHaveLength(3);
  });

  it("re-checks inside the flow and denies a break-glass designee", async () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "bg-admin");
    bundle.sqlite.prepare(`UPDATE users SET role = 'admin' WHERE id = 'bg-admin'`).run();
    const issued = issueResetToken(
      { userId: "bg-admin", source: "admin", delivery: "operator_handoff" },
      bundle.db,
    );
    bundle.sqlite
      .prepare(
        `INSERT INTO auth_control (id, break_glass_user_id, updated_at, updated_by_user_id, change_reason)
         VALUES (1, 'bg-admin', ?, NULL, 'test designation reason')`,
      )
      .run(T0);

    const result = await completePasswordReset(
      { rawToken: issued.rawToken, password: "NewPassword!234", ip: "10.2.2.2" },
      bundle,
    );

    expect(result.ok).toBe(false);
    const stillHash = bundle.sqlite
      .prepare(`SELECT password_hash AS h FROM users WHERE id = 'bg-admin'`)
      .get() as { h: string };
    expect(stillHash.h).toBe("hash");
  });

  it("denies redemption when the target was deactivated after issuance", async () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    const issued = issueResetToken(
      { userId: "user-1", source: "admin", delivery: "operator_handoff" },
      bundle.db,
    );
    bundle.sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = 'user-1'`).run();

    const result = await completePasswordReset(
      { rawToken: issued.rawToken, password: "NewPassword!234", ip: "10.3.3.3" },
      bundle,
    );

    expect(result).toEqual({ ok: false, message: PASSWORD_RESET_COPY.REDEEM_FAILURE });
    const row = bundle.sqlite
      .prepare(`SELECT password_hash AS h FROM users WHERE id = 'user-1'`)
      .get() as { h: string };
    expect(row.h).toBe("hash");
    const denials = securityEventRows(bundle.sqlite).filter(
      (e) => e.type === "password.reset.redeem_denied",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]!.metadata).toContain("inactive_target");
  });

  it("denies redemption when the credential was retired to the disabled sentinel after issuance", async () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    const issued = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
    );
    bundle.sqlite
      .prepare(`UPDATE users SET password_hash = 'disabled:abc123' WHERE id = 'user-1'`)
      .run();

    const result = await completePasswordReset(
      { rawToken: issued.rawToken, password: "NewPassword!234", ip: "10.4.4.4" },
      bundle,
    );

    expect(result).toEqual({ ok: false, message: PASSWORD_RESET_COPY.REDEEM_FAILURE });
    const row = bundle.sqlite
      .prepare(`SELECT password_hash AS h FROM users WHERE id = 'user-1'`)
      .get() as { h: string };
    expect(row.h).toBe("disabled:abc123");
    const denials = securityEventRows(bundle.sqlite).filter(
      (e) => e.type === "password.reset.redeem_denied",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]!.metadata).toContain("credential_disabled");
  });

  it("rate limits redemption failures per IP", async () => {
    const bundle = openAppDatabase(":memory:");
    for (let i = 0; i < 11; i++) {
      await completePasswordReset(
        { rawToken: "guessed-token", password: "AttemptPassword1", ip: "10.0.0.9" },
        bundle,
      );
    }
    const denials = securityEventRows(bundle.sqlite).filter(
      (e) => e.type === "password.reset.redeem_denied",
    );
    expect(denials.some((e) => e.metadata.includes("rate_limited"))).toBe(true);
  });
});
