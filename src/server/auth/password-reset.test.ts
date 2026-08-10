import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/reset-mailer", () => ({
  sendPasswordResetEmail: vi.fn(async () => ({})),
}));

import { sendPasswordResetEmail } from "@/server/auth/reset-mailer";
import { requestPasswordReset } from "@/server/auth/password-reset";
import {
  resetRequestByEmailLimiter,
  resetRequestByIpLimiter,
} from "@/server/auth/password-reset-rate-limit";
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
