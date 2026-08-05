import { describe, expect, it } from "vitest";
import { openAppDatabase } from "@/server/db/client";
import {
  consumeBreakGlassCeremony,
  isEmergencyAttemptLocked,
  issueBreakGlassCeremony,
  peekBreakGlassCeremony,
  recordFailedEmergencyAttempt,
  resetEmergencyAttempts,
  resolveWebAuthnRelyingParty,
} from "@/server/auth/webauthn";

describe("break-glass ceremony tokens", () => {
  function ceremonyDb() {
    const bundle = openAppDatabase(":memory:");
    const now = new Date().toISOString();
    bundle.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ('user-1', 'u@example.com', 'U', 'hash', 'admin', 1, ?, ?)`,
      )
      .run(now, now);
    return bundle;
  }

  it("issues a short-lived, single-use token bound to user and reason", () => {
    const { db } = ceremonyDb();
    const id = issueBreakGlassCeremony(
      {
        userId: "user-1",
        reason: "IdP outage in region.",
        sourceZone: "management",
        via: "webauthn",
      },
      db,
    );

    const peeked = peekBreakGlassCeremony(id, db);
    expect(peeked).toMatchObject({ userId: "user-1", reason: "IdP outage in region." });

    const consumed = consumeBreakGlassCeremony(id, db);
    expect(consumed?.id).toBe(id);
    expect(peekBreakGlassCeremony(id, db)).toBeNull();
    expect(consumeBreakGlassCeremony(id, db)).toBeNull();
  });

  it("never issues for unknown or expired tokens", () => {
    const { db } = ceremonyDb();
    expect(peekBreakGlassCeremony("missing", db)).toBeNull();
    expect(consumeBreakGlassCeremony("missing", db)).toBeNull();
  });
});

describe("emergency attempt rate limiting", () => {
  const USER = "rate-user";

  it("locks after five consecutive failures and recovers after the window", () => {
    resetEmergencyAttempts(USER);
    expect(isEmergencyAttemptLocked(USER)).toBe(false);

    const t0 = new Date("2026-08-03T12:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      recordFailedEmergencyAttempt(USER, t0);
    }
    expect(isEmergencyAttemptLocked(USER, t0)).toBe(true);

    const after = new Date(t0.getTime() + 16 * 60 * 1000);
    expect(isEmergencyAttemptLocked(USER, after)).toBe(false);
  });

  it("resets the counter on a successful start", () => {
    resetEmergencyAttempts(USER);
    const t0 = new Date("2026-08-03T12:00:00.000Z");
    for (let index = 0; index < 4; index += 1) {
      recordFailedEmergencyAttempt(USER, t0);
    }
    resetEmergencyAttempts(USER);
    recordFailedEmergencyAttempt(USER, t0);
    expect(isEmergencyAttemptLocked(USER, t0)).toBe(false);
  });
});

describe("relying party derivation", () => {
  it("takes origin and rpID from NEXTAUTH_URL", () => {
    expect(
      resolveWebAuthnRelyingParty({ NEXTAUTH_URL: "https://superscriber.example.org/" }),
    ).toEqual({
      rpID: "superscriber.example.org",
      origin: "https://superscriber.example.org",
      rpName: "Superscriber",
    });
  });

  it("supports local loopback testing origins", () => {
    const rp = resolveWebAuthnRelyingParty({ NEXTAUTH_URL: "http://127.0.0.1:3105" });
    expect(rp).toMatchObject({ rpID: "127.0.0.1", origin: "http://127.0.0.1:3105" });
  });
});

describe("registration challenge storage", () => {
  it("creates a registration challenge with resident-key requirements", async () => {
    const bundle = openAppDatabase(":memory:");
    const now = new Date().toISOString();
    bundle.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, role, is_active, created_at, updated_at)
         VALUES ('bg', 'bg@example.com', 'BG', 'admin', 1, ?, ?)`,
      )
      .run(now, now);

    const { beginRegistrationChallenge } = await import("@/server/auth/webauthn");
    const { challengeId, publicKey } = await beginRegistrationChallenge(
      { userId: "bg", userName: "bg@example.com", userDisplayName: "BG" },
      bundle.db,
    );

    expect(challengeId).toBeTruthy();
    expect(publicKey.rp).toBeDefined();
    expect(publicKey.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
      authenticatorAttachment: "cross-platform",
    });
    expect(publicKey.attestation).toBe("none");
  });
});
