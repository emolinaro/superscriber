import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://auth.example.com/application/o/superscriber/";
const PASSWORD = "HighEntropy!BreakGlass42";
const REASON = "Authentik outage during regional maintenance window.";

describe("break-glass ceremony through Auth.js", () => {
  vi.setConfig({ testTimeout: 20_000 });  // bcrypt + ceremony crypto under full-suite parallel load
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-bgc-"));
    writeFileSync(join(dir, "client-secret"), "secret\n");
    writeFileSync(
      join(dir, "role-map.json"),
      JSON.stringify({
        version: 1,
        issuer: ISSUER,
        claim: "superscriber_role_group_ids",
        groups: {
          uploader: "11111111-1111-4111-8111-111111111111",
          reviewer: "22222222-2222-4222-8222-222222222222",
          approver: "33333333-3333-4333-8333-333333333333",
          admin: "44444444-4444-4444-8444-444444444444",
        },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  function stubEnv(dbPath: string) {
    vi.stubEnv("SUPERSCRIBER_DB_PATH", dbPath);
    vi.stubEnv("SUPERSCRIBER_AUTH_MODE", "dual");
    vi.stubEnv("SUPERSCRIBER_OIDC_ISSUER", ISSUER);
    vi.stubEnv("SUPERSCRIBER_OIDC_CLIENT_ID", "superscriber");
    vi.stubEnv("SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE", join(dir, "client-secret"));
    vi.stubEnv("SUPERSCRIBER_OIDC_ROLE_MAP_FILE", join(dir, "role-map.json"));
    vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:3105");
  }

  it("mints a short break-glass session after a completed recovery ceremony", async () => {
    const dbPath = join(dir, "app.db");
    vi.resetModules();
    stubEnv(dbPath);

    const { openAppDatabase } = await import("@/server/db/client");
    const bundle = openAppDatabase(dbPath);
    const { createLocalUser } = await import("@/server/auth/service");
    const admin = await createLocalUser(
      { displayName: "BG Custodian", email: "bg@example.com", password: PASSWORD, role: "admin" },
      bundle.db,
    );
    const { designateBreakGlassUser, generateBreakGlassRecoveryCodes } = await import(
      "@/server/auth/break-glass"
    );
    designateBreakGlassUser({ userId: admin.id, changeReason: "Initial." }, bundle.db);
    const { codes } = generateBreakGlassRecoveryCodes({ userId: admin.id }, bundle.db);

    const { beginEmergencyRecovery } = await import("@/server/auth/emergency-access");
    const begin = await beginEmergencyRecovery(
      { password: PASSWORD, recoveryCode: codes[0], reason: REASON, zone: "management" },
      bundle.db,
    );
    expect(begin).toMatchObject({ ok: true });
    const ceremonyToken = (begin as { ceremonyToken: string }).ceremonyToken;

    const { authOptions } = await import("@/server/auth/options");
    const credentials = authOptions.providers.find(
      (provider: { id: string }) => provider.id === "credentials",
    ) as { options: { authorize: (input: unknown) => Promise<unknown> } };

    // authorize exchanges the ceremony (peek only); jwt consumes it.
    const rawUser = (await credentials.options.authorize({
      breakGlassCeremony: ceremonyToken,
    })) as Record<string, unknown>;
    expect(rawUser).toMatchObject({ id: admin.id, role: "admin" });

    const token = (await authOptions.callbacks!.jwt!({
      token: {},
      user: rawUser,
      account: { provider: "credentials" },
    } as never)) as Record<string, unknown>;

    expect(token.tokenVersion).toBe(2);
    expect(token.userId).toBe(admin.id);
    expect(token.authSource).toBe("break_glass");
    expect(typeof token.authSessionId).toBe("string");

    const sessionRow = bundle.sqlite
      .prepare(
        `SELECT auth_source AS authSource, emergency_activation_id AS activationId,
                absolute_expires_at AS absExp, idle_expires_at AS idleExp, created_at AS createdAt
         FROM auth_sessions WHERE id = ?`,
      )
      .get(token.authSessionId) as Record<string, string>;
    expect(sessionRow.authSource).toBe("break_glass");
    expect(sessionRow.activationId).toBeTruthy();

    const absMs = Date.parse(sessionRow.absExp) - Date.parse(sessionRow.createdAt);
    const idleMs = Date.parse(sessionRow.idleExp) - Date.parse(sessionRow.createdAt);
    expect(absMs).toBe(15 * 60 * 1000);
    expect(idleMs).toBe(5 * 60 * 1000);

    const activation = bundle.sqlite
      .prepare(`SELECT reason, source_zone AS zone FROM emergency_activations WHERE id = ?`)
      .get(sessionRow.activationId) as { reason: string; zone: string };
    expect(activation).toEqual({ reason: REASON, zone: "management" });

    // The ceremony token is consumed: a second authorize or mint fails.
    expect(
      await credentials.options.authorize({ breakGlassCeremony: ceremonyToken }),
    ).toBeNull();
  });

  it("denies a made-up ceremony token", async () => {
    const dbPath = join(dir, "app2.db");
    vi.resetModules();
    stubEnv(dbPath);
    const { openAppDatabase } = await import("@/server/db/client");
    openAppDatabase(dbPath);

    const { authOptions } = await import("@/server/auth/options");
    const credentials = authOptions.providers.find(
      (provider: { id: string }) => provider.id === "credentials",
    ) as { options: { authorize: (input: unknown) => Promise<unknown> } };

    expect(
      await credentials.options.authorize({ breakGlassCeremony: "forged-token" }),
    ).toBeNull();
  });
});
