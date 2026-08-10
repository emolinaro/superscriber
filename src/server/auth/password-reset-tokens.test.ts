import { describe, expect, it } from "vitest";
import {
  RESET_TOKEN_TTL_MS,
  checkSelfServiceEligibility,
  issueResetToken,
  loadRedeemableToken,
  markResetTokenUsed,
} from "@/server/auth/password-reset-tokens";
import { openAppDatabase } from "@/server/db/client";

const T0 = new Date("2026-08-10T12:00:00.000Z");

function seedUser(
  sqlite: import("better-sqlite3").Database,
  id: string,
  passwordHash: string | null = "hash",
) {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'reviewer', 1, ?, ?)`,
    )
    .run(id, `${id}@example.com`, id, passwordHash, T0.toISOString(), T0.toISOString());
}

describe("password reset token store", () => {
  it("issues hashed single-use tokens; raw token is never persisted", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");

    const issued = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
      T0,
    );
    expect(issued.rawToken).not.toContain("=");
    expect(issued.expiresAt).toBe(new Date(T0.getTime() + RESET_TOKEN_TTL_MS).toISOString());

    const row = bundle.sqlite
      .prepare(`SELECT token_hash FROM password_reset_tokens WHERE id = ?`)
      .get(issued.tokenId) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(issued.rawToken);
  });

  it("new issuance supersedes outstanding tokens; latest wins", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    const first = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
      T0,
    );
    const second = issueResetToken(
      {
        userId: "user-1",
        source: "admin",
        delivery: "operator_handoff",
        requestedByUserId: "user-1",
        supersedeReason: "admin_precedence",
      },
      bundle.db,
      T0,
    );

    expect(loadRedeemableToken(first.rawToken, bundle.db, T0)).toEqual({
      ok: false,
      reason: "invalidated",
    });
    const row = bundle.sqlite
      .prepare(`SELECT invalidated_reason FROM password_reset_tokens WHERE id = ?`)
      .get(first.tokenId) as { invalidated_reason: string };
    expect(row.invalidated_reason).toBe("admin_precedence");
    expect(loadRedeemableToken(second.rawToken, bundle.db, T0).ok).toBe(true);
  });

  it("enforces expiry and single use", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "user-1");
    const issued = issueResetToken(
      { userId: "user-1", source: "self_service", delivery: "email" },
      bundle.db,
      T0,
    );

    expect(
      loadRedeemableToken(issued.rawToken, bundle.db, new Date(T0.getTime() + RESET_TOKEN_TTL_MS - 1000)).ok,
    ).toBe(true);
    expect(
      loadRedeemableToken(issued.rawToken, bundle.db, new Date(T0.getTime() + RESET_TOKEN_TTL_MS)),
    ).toEqual({ ok: false, reason: "expired" });

    markResetTokenUsed(issued.tokenId, bundle.db, T0.toISOString());
    expect(loadRedeemableToken(issued.rawToken, bundle.db, T0)).toEqual({
      ok: false,
      reason: "used",
    });
    expect(loadRedeemableToken("not-a-token", bundle.db, T0)).toEqual({
      ok: false,
      reason: "unknown_token",
    });
  });

  it("self-service eligibility excludes unknown, oidc-only, disabled, inactive, and break-glass", () => {
    const bundle = openAppDatabase(":memory:");
    seedUser(bundle.sqlite, "ok");
    seedUser(bundle.sqlite, "oidc-only", null);
    seedUser(bundle.sqlite, "disabled", "disabled:abc");
    seedUser(bundle.sqlite, "inactive-user");
    bundle.sqlite.prepare(`UPDATE users SET is_active = 0 WHERE id = 'inactive-user'`).run();
    seedUser(bundle.sqlite, "designee");
    bundle.sqlite.prepare(`UPDATE users SET role = 'admin' WHERE id = 'designee'`).run();
    bundle.sqlite
      .prepare(
        `INSERT INTO auth_control (id, break_glass_user_id, updated_at, updated_by_user_id, change_reason)
                VALUES (1, 'designee', ?, NULL, 'test designation reason')`,
      )
      .run(T0.toISOString());

    expect(checkSelfServiceEligibility("ok@example.com", bundle.db)).toEqual({
      eligible: true,
      userId: "ok",
      email: "ok@example.com",
    });
    expect(checkSelfServiceEligibility("designee@example.com", bundle.db)).toEqual({
      eligible: false,
      reason: "break_glass_designee",
    });
    expect(checkSelfServiceEligibility("oidc-only@example.com", bundle.db).eligible).toBe(false);
    expect(checkSelfServiceEligibility("disabled@example.com", bundle.db).eligible).toBe(false);
    expect(checkSelfServiceEligibility("inactive-user@example.com", bundle.db).eligible).toBe(false);
    expect(checkSelfServiceEligibility("ghost@example.com", bundle.db)).toEqual({
      eligible: false,
      reason: "unknown_or_ineligible",
    });
  });
});
