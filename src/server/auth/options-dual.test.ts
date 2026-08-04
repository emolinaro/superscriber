import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://auth.example.com/application/o/superscriber/";
const GROUPS = {
  uploader: "11111111-1111-4111-8111-111111111111",
  reviewer: "22222222-2222-4222-8222-222222222222",
  approver: "33333333-3333-4333-8333-333333333333",
  admin: "44444444-4444-4444-8444-444444444444",
};

describe("auth options in dual mode", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-dual-"));
    writeFileSync(join(dir, "client-secret"), "secret\n");
    writeFileSync(
      join(dir, "role-map.json"),
      JSON.stringify({
        version: 1,
        issuer: ISSUER,
        claim: "superscriber_role_group_ids",
        groups: GROUPS,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  function stubEnv(dbPath: string, mode = "dual") {
    vi.stubEnv("SUPERSCRIBER_DB_PATH", dbPath);
    vi.stubEnv("SUPERSCRIBER_AUTH_MODE", mode);
    vi.stubEnv("SUPERSCRIBER_OIDC_ISSUER", ISSUER);
    vi.stubEnv("SUPERSCRIBER_OIDC_CLIENT_ID", "superscriber");
    vi.stubEnv("SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE", join(dir, "client-secret"));
    vi.stubEnv("SUPERSCRIBER_OIDC_ROLE_MAP_FILE", join(dir, "role-map.json"));
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3105");
  }

  async function seedLinkedUser(dbPath: string) {
    const { openAppDatabase } = await import("@/server/db/client");
    const bundle = openAppDatabase(dbPath);
    const now = new Date().toISOString();
    bundle.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ('user-reviewer', 'dual@example.com', 'Dual Reviewer', NULL, 'reviewer', 1, ?, ?)`,
      )
      .run(now, now);
    const { applyIdentityLink } = await import("@/server/auth/identity-links");
    const link = applyIdentityLink(
      {
        userId: "user-reviewer",
        issuer: ISSUER,
        subject: "dual-sub-1",
        changeReason: "Test link.",
      },
      bundle.db,
    );
    return { link };
  }

  it("registers only credentials in local mode and both providers in dual mode", async () => {
    stubEnv(join(dir, "local.db"), "local");
    const localOptions = (await import("@/server/auth/options")).authOptions;
    expect(localOptions.providers.map((p: { id: string }) => p.id)).toEqual(["credentials"]);

    vi.resetModules();
    stubEnv(join(dir, "dual.db"), "dual");
    const dualOptions = (await import("@/server/auth/options")).authOptions;
    expect(dualOptions.providers.map((p: { id: string }) => p.id)).toEqual([
      "credentials",
      "authentik",
    ]);
  });

  it("runs admission in signIn and mints a registry-backed token with the local id in jwt", async () => {
    const dbPath = join(dir, "dual.db");
    stubEnv(dbPath, "dual");
    const { link } = await seedLinkedUser(dbPath);

    vi.resetModules();
    stubEnv(dbPath, "dual");
    const { authOptions } = await import("@/server/auth/options");

    const claims = {
      iss: ISSUER,
      sub: "dual-sub-1",
      sid: "sid-dual",
      name: "Dual Reviewer",
      superscriber_role_group_ids: [GROUPS.reviewer],
    };

    const allowed = await authOptions.callbacks!.signIn!({
      user: { id: "dual-sub-1", name: "Dual Reviewer" },
      account: { provider: "authentik" },
      profile: claims,
    } as never);
    expect(allowed).toBe(true);

    const denied = await authOptions.callbacks!.signIn!({
      user: { id: "ghost", name: "Ghost" },
      account: { provider: "authentik" },
      profile: { ...claims, sub: "ghost" },
    } as never);
    expect(denied).toBe(false);

    const token = (await authOptions.callbacks!.jwt!({
      token: {},
      user: { id: "dual-sub-1", name: "Dual Reviewer" },
      account: { provider: "authentik" },
      profile: claims,
    } as never)) as Record<string, unknown>;

    expect(token.tokenVersion).toBe(2);
    expect(token.userId).toBe("user-reviewer");
    expect(token.authSource).toBe("authentik");
    expect(typeof token.authSessionId).toBe("string");

    const { openAppDatabase } = await import("@/server/db/client");
    const bundle = openAppDatabase(dbPath);
    const sessionRow = bundle.sqlite
      .prepare(
        `SELECT user_id AS userId, auth_source AS authSource, external_identity_id AS externalIdentityId, provider_sid AS providerSid
         FROM auth_sessions WHERE id = ?`,
      )
      .get(token.authSessionId) as Record<string, unknown>;
    expect(sessionRow).toEqual({
      userId: "user-reviewer",
      authSource: "authentik",
      externalIdentityId: link.id,
      providerSid: "sid-dual",
    });
  });

  it("authentik-primary credentials accept only the designated break-glass account", async () => {
    const dbPath = join(dir, "primary.db");
    stubEnv(dbPath, "authentik-primary");

    const { openAppDatabase } = await import("@/server/db/client");
    const bundle = openAppDatabase(dbPath);
    const { createLocalUser } = await import("@/server/auth/service");
    const admin = await createLocalUser(
      {
        displayName: "BG Admin",
        email: "bg@example.com",
        password: "Superscriber!123",
        role: "admin",
      },
      bundle.db,
    );
    await createLocalUser(
      {
        displayName: "Normal Reviewer",
        email: "normal@example.com",
        password: "Superscriber!123",
        role: "reviewer",
      },
      bundle.db,
    );

    vi.resetModules();
    stubEnv(dbPath, "authentik-primary");
    const { authOptions } = await import("@/server/auth/options");
    // next-auth v4 CredentialsProvider keeps the real authorize under
    // .options; the top-level field is a () => null stub.
    const credentials = authOptions.providers.find(
      (provider: { id: string }) => provider.id === "credentials",
    ) as { options: { authorize: (input: unknown) => Promise<unknown> } };
    const authorize = credentials.options.authorize;

    // Without a designation, nobody passes credentials in primary mode.
    expect(
      await authorize({ email: "bg@example.com", password: "Superscriber!123" }),
    ).toBeNull();

    const { designateBreakGlassUser } = await import("@/server/auth/break-glass");
    designateBreakGlassUser(
      { userId: admin.id, changeReason: "Break-glass designation." },
      bundle.db,
    );

    expect(
      await authorize({ email: "normal@example.com", password: "Superscriber!123" }),
    ).toBeNull();

    expect(
      await authorize({ email: "bg@example.com", password: "Superscriber!123" }),
    ).toMatchObject({ id: admin.id, role: "admin" });
  });

  it("jwt denies an identity whose admission fails at mint time", async () => {
    const dbPath = join(dir, "dual2.db");
    stubEnv(dbPath, "dual");
    await seedLinkedUser(dbPath);
    vi.resetModules();
    stubEnv(dbPath, "dual");
    const { authOptions } = await import("@/server/auth/options");

    // Role changed between signIn and jwt: admission must deny the mint.
    const claims = {
      iss: ISSUER,
      sub: "dual-sub-1",
      superscriber_role_group_ids: [GROUPS.approver],
    };
    const token = (await authOptions.callbacks!.jwt!({
      token: {},
      user: { id: "dual-sub-1", name: "Dual Reviewer" },
      account: { provider: "authentik" },
      profile: claims,
    } as never)) as Record<string, unknown>;

    expect(token).toEqual({});
  });
});
