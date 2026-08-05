import { describe, expect, it, vi } from "vitest";
import {
  beginEmergencyAccess,
  beginEmergencyRecovery,
} from "@/server/auth/emergency-access";
import {
  designateBreakGlassUser,
  generateBreakGlassRecoveryCodes,
} from "@/server/auth/break-glass";
import { resetEmergencyAttempts } from "@/server/auth/webauthn";
import { hash } from "bcryptjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { openAppDatabase } from "@/server/db/client";

const PASSWORD = "HighEntropy!BreakGlass42";
const REASON = "Authentik outage during region maintenance window.";
const ISSUER = "https://auth.example.com/application/o/superscriber/";

describe("emergency access", () => {
  vi.setConfig({ testTimeout: 20_000 });  // bcrypt + ceremony crypto under full-suite parallel load
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-emg-"));
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
    process.env.SUPERSCRIBER_AUTH_MODE = "dual";
    process.env.SUPERSCRIBER_OIDC_ISSUER = ISSUER;
    process.env.SUPERSCRIBER_OIDC_CLIENT_ID = "superscriber";
    process.env.SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE = join(dir, "client-secret");
    process.env.SUPERSCRIBER_OIDC_ROLE_MAP_FILE = join(dir, "role-map.json");
  });

  afterEach(() => {
    delete process.env.SUPERSCRIBER_AUTH_MODE;
    delete process.env.SUPERSCRIBER_OIDC_ISSUER;
    delete process.env.SUPERSCRIBER_OIDC_CLIENT_ID;
    delete process.env.SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE;
    delete process.env.SUPERSCRIBER_OIDC_ROLE_MAP_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const bundle = openAppDatabase(":memory:");
    const now = new Date().toISOString();
    const passwordHash = await hash(PASSWORD, 12);
    bundle.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ('bg-user', 'bg@example.com', 'BG Custodian', ?, 'admin', 1, ?, ?)`,
      )
      .run(passwordHash, now, now);
    designateBreakGlassUser({ userId: "bg-user", changeReason: "Initial." }, bundle.db);
    resetEmergencyAttempts("bg-user");
    return bundle;
  }

  it("denies outside the management boundary with a generic message and one event", async () => {
    const bundle = await setup();

    const result = await beginEmergencyAccess(
      { password: PASSWORD, reason: REASON, zone: "public" },
      bundle.db,
    );

    expect(result).toEqual({
      ok: false,
      error: "The emergency access request was not accepted.",
    });

    const events = bundle.sqlite
      .prepare(`SELECT type, outcome, detail, metadata FROM security_events WHERE type = 'breakglass.emergency_denied'`)
      .all() as Array<{ detail: string; metadata: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].detail).not.toContain("password");
    expect(JSON.parse(events[0].metadata).data).toMatchObject({ reason: "untrusted_source" });
  });

  it("denies without a designation and with a bad password, tracking lockout", async () => {
    const bundle = openAppDatabase(":memory:");
    const now = new Date().toISOString();
    bundle.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ('u', 'u@example.com', 'U', 'hash', 'admin', 1, ?, ?)`,
      )
      .run(now, now);

    expect(
      await beginEmergencyAccess({ password: "x", reason: REASON, zone: "management" }, bundle.db),
    ).toMatchObject({ ok: false });

    const withDesignation = await setup();
    const userId = "bg-user";
    for (let index = 0; index < 5; index += 1) {
      await beginEmergencyAccess(
        { password: "wrong-password", reason: REASON, zone: "management" },
        withDesignation.db,
      );
    }

    // Sixth attempt is locked before password evaluation.
    const locked = await beginEmergencyAccess(
      { password: PASSWORD, reason: REASON, zone: "management" },
      withDesignation.db,
    );
    expect(locked).toMatchObject({ ok: false });

    const denied = withDesignation.sqlite
      .prepare(
        `SELECT metadata FROM security_events WHERE type = 'breakglass.emergency_denied'`,
      )
      .all() as Array<{ metadata: string }>;
    const reasons = denied
      .map((row) => JSON.parse(row.metadata).data.reason as string)
      .sort();
    expect(reasons).toEqual([
      "authentication_failed",
      "authentication_failed",
      "authentication_failed",
      "authentication_failed",
      "authentication_failed",
      "temporarily_locked",
    ]);
  });

  it("asks for recovery when no keys are enrolled, and issues a ceremony token on recovery success", async () => {
    const bundle = await setup();
    const { codes } = generateBreakGlassRecoveryCodes({ userId: "bg-user" }, bundle.db);

    const start = await beginEmergencyAccess(
      { password: PASSWORD, reason: REASON, zone: "management" },
      bundle.db,
    );
    expect(start).toEqual({ ok: true, needsRecovery: true });

    const recovery = await beginEmergencyRecovery(
      { password: PASSWORD, recoveryCode: codes[0], reason: REASON, zone: "management" },
      bundle.db,
    );
    expect(recovery).toMatchObject({ ok: true, ceremonyToken: expect.any(String) });

    // Code is single-use.
    const replay = await beginEmergencyRecovery(
      { password: PASSWORD, recoveryCode: codes[0], reason: REASON, zone: "management" },
      bundle.db,
    );
    expect(replay).toMatchObject({ ok: false });
  });

  it("issues a WebAuthn challenge when keys are enrolled", async () => {
    const bundle = await setup();
    bundle.sqlite
      .prepare(
        `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, label, created_at)
         VALUES ('cred-1', 'bg-user', 'cHVibGljLWtleQ==', 0, 'Key 1', ?)`,
      )
      .run(new Date().toISOString());

    const result = await beginEmergencyAccess(
      { password: PASSWORD, reason: REASON, zone: "management" },
      bundle.db,
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok && "publicKey" in result) {
      expect(result.challengeId).toBeTruthy();
      const allow = (result.publicKey as { allowCredentials: Array<{ id: string; type: string }> })
        .allowCredentials;
      expect(allow).toHaveLength(1);
      expect(allow[0]).toMatchObject({ id: "cred-1", type: "public-key" });
      expect((result.publicKey as { userVerification: string }).userVerification).toBe(
        "required",
      );
    }
  });
});
