import { describe, expect, it } from "vitest";
import { getAuthHealthSummary } from "@/server/auth/auth-health";
import { applyIdentityLink } from "@/server/auth/identity-links";
import { resolveOidcAdmission, type OidcAuthConfig } from "@/server/auth/oidc-admission";
import { createAuthSession } from "@/server/auth/session-registry";
import { openAppDatabase } from "@/server/db/client";

const ISSUER = "https://auth.example.com/application/o/superscriber/";
const GROUPS = {
  uploader: "11111111-1111-4111-8111-111111111111",
  reviewer: "22222222-2222-4222-8222-222222222222",
  approver: "33333333-3333-4333-8333-333333333333",
  admin: "44444444-4444-4444-8444-444444444444",
};

const CONFIG: OidcAuthConfig = {
  mode: "dual",
  oidc: { issuer: ISSUER, clientId: "superscriber", clientSecretFile: "/dev/null" },
  roleMap: { version: 1, issuer: ISSUER, claim: "superscriber_role_group_ids", groups: GROUPS },
};

describe("auth health summary", () => {
  it("reports redacted counts across sessions, admissions, links, and break-glass", () => {
    const bundle = openAppDatabase(":memory:");
    const { db } = bundle;
    const now = "2026-08-03T12:00:00.000Z";
    const insert = bundle.sqlite.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', ?, 1, ?, ?)`,
    );
    insert.run("user-a", "health-a@example.com", "A", "reviewer", now, now);
    insert.run("user-op", "health-op@example.com", "Op", "admin", now, now);

    createAuthSession({ userId: "user-a", authSource: "local" }, db);
    const link = applyIdentityLink(
      { userId: "user-a", issuer: ISSUER, subject: "health-sub", changeReason: "t" },
      db,
    );
    createAuthSession(
      { userId: "user-a", authSource: "authentik", externalIdentityId: link.id, providerSid: "s-1" },
      db,
    );

    resolveOidcAdmission(
      {
        claims: { iss: ISSUER, sub: "health-sub", superscriber_role_group_ids: [GROUPS.reviewer] },
        config: CONFIG,
      },
      db,
    );
    resolveOidcAdmission(
      { claims: { iss: ISSUER, sub: "ghost" }, config: CONFIG },
      db,
    );

    const summary = getAuthHealthSummary(db);

    expect(summary.sessions.active).toBe(2);
    expect(summary.sessions.bySource).toEqual({ local: 1, authentik: 1 });
    expect(summary.oidcAdmission24h).toEqual({ allowed: 1, denied: 1 });
    expect(summary.identityLinks).toEqual({ active: 1, retired: 0 });
    expect(summary.breakGlass).toEqual({
      designated: false,
      enrolledKeyCount: 0,
      recoveryCodeCount: 0,
    });

    const copy = JSON.stringify(summary);
    expect(copy).not.toContain("@");
    expect(copy).not.toContain("health-sub");
    expect(copy).not.toContain("s-1");
  });

  it("reports configuration state without leaking paths or material", () => {
    const bundle = openAppDatabase(":memory:");

    const incomplete = getAuthHealthSummary(bundle.db, {
      env: { SUPERSCRIBER_AUTH_MODE: "dual" },
    });
    expect(incomplete.mode).toBe("dual");
    expect(incomplete.oidcConfigured).toBe(false);
    expect(incomplete.configError).toBe("incomplete OIDC settings");
    expect(incomplete.configError).not.toContain("/");

    const invalid = getAuthHealthSummary(bundle.db, {
      env: { SUPERSCRIBER_AUTH_MODE: "nonsense" },
    });
    expect(invalid.configError).toBe("invalid auth configuration");

    const local = getAuthHealthSummary(bundle.db, { env: {} });
    expect(local).toMatchObject({ mode: "local", oidcConfigured: false, configError: null });
  });
});
