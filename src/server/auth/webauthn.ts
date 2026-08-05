import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, isNull } from "drizzle-orm";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import { breakGlassCeremonies, webauthnCredentials } from "@/server/db/schema";

/**
 * Break-glass WebAuthn ceremonies (plan sections 8.1-8.3).
 *
 * Crypto verification is delegated to @simplewebauthn/server (captain-approved
 * dependency, 13.3.2 pinned). Challenges and one-time ceremony tokens live in
 * process memory: they are short-lived, single-use, and worthless across a
 * restart. The browser ceremony is hand-rolled with navigator.credentials -
 * no browser library.
 */

export type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const CEREMONY_TTL_MS = 60 * 1000;
const MAX_ENROLLED_KEYS = 4;

export function resolveWebAuthnRelyingParty(
  env: Record<string, string | undefined> = process.env,
): {
  rpID: string;
  origin: string;
  rpName: string;
} {
  const rawOrigin = env.NEXTAUTH_URL?.trim() || "http://localhost:3000";
  const origin = new URL(rawOrigin).origin;
  return { rpID: new URL(origin).hostname, origin, rpName: "Superscriber" };
}

type ChallengeRecord = {
  id: string;
  challenge: string;
  userId: string;
  kind: "registration" | "authentication";
  label: string | null;
  expiresAtMs: number;
  consumed: boolean;
};

export type BreakGlassCeremonyRecord = typeof breakGlassCeremonies.$inferSelect;

const challenges = new Map<string, ChallengeRecord>();

function sweep(map: Map<string, { expiresAtMs: number }>, nowMs: number) {
  for (const [key, value] of map) {
    if (value.expiresAtMs <= nowMs) {
      map.delete(key);
    }
  }
}

export function beginRegistrationChallenge(
  params: { userId: string; userName: string; userDisplayName: string; label?: string },
  db: AppDatabase = getAppDb(),
  options: { now?: Date } = {},
) {
  const { rpName, rpID } = resolveWebAuthnRelyingParty();
  const existing = db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, params.userId))
    .all();

  if (existing.length >= MAX_ENROLLED_KEYS) {
    throw new Error(`The break-glass account already holds the maximum of ${MAX_ENROLLED_KEYS} security keys.`);
  }

  const nowMs = (options.now ?? new Date()).getTime();
  sweep(challenges, nowMs);

  // WebAuthn user ids are bytes; encode the local stable id verbatim.
  return generateRegistrationOptions({
    rpName,
    rpID,
    userName: params.userName,
    userDisplayName: params.userDisplayName,
    userID: new TextEncoder().encode(params.userId),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
      authenticatorAttachment: "cross-platform",
    },
    excludeCredentials: existing.map((row) => ({
      id: row.id,
      transports: row.transports ? (JSON.parse(row.transports) as never[]) : undefined,
    })),
    timeout: CHALLENGE_TTL_MS,
  }).then((publicKey) => {
    const record: ChallengeRecord = {
      id: crypto.randomUUID(),
      challenge: publicKey.challenge,
      userId: params.userId,
      kind: "registration",
      label: params.label ?? null,
      expiresAtMs: nowMs + CHALLENGE_TTL_MS,
      consumed: false,
    };
    challenges.set(record.id, record);
    return { challengeId: record.id, publicKey };
  });
}

export async function completeRegistration(
  params: { challengeId: string; response: unknown; label?: string },
  db: AppDatabase = getAppDb(),
) {
  const record = challenges.get(params.challengeId);
  if (!record || record.kind !== "registration" || record.consumed) {
    throw new Error("Unknown or expired registration challenge.");
  }
  record.consumed = true;

  if (record.expiresAtMs <= Date.now()) {
    throw new Error("Registration challenge expired.");
  }

  const { origin, rpID } = resolveWebAuthnRelyingParty();
  const verification = await verifyRegistrationResponse({
    response: params.response as never,
    expectedChallenge: record.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Security key registration was not verified.");
  }

  const { credential } = verification.registrationInfo;
  const publicKeyB64 = Buffer.from(credential.publicKey).toString("base64");
  const label = params.label ?? record.label ?? "";

  db.insert(webauthnCredentials)
    .values({
      id: credential.id,
      userId: record.userId,
      publicKey: publicKeyB64,
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    })
    .run();

  return { credentialId: credential.id };
}

export function listBreakGlassKeys(userId: string, db: AppDatabase = getAppDb()) {
  return db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .all();
}

export async function beginAuthenticationChallenge(
  params: { userId: string },
  db: AppDatabase = getAppDb(),
  options: { now?: Date } = {},
) {
  const keys = listBreakGlassKeys(params.userId, db);
  if (keys.length === 0) {
    return { challengeId: null, publicKey: null, needsRecovery: true as const };
  }

  const { rpID } = resolveWebAuthnRelyingParty();
  const nowMs = (options.now ?? new Date()).getTime();
  sweep(challenges, nowMs);

  const publicKey = await generateAuthenticationOptions({
    rpID,
    allowCredentials: keys.map((row) => ({
      id: row.id,
      transports: row.transports ? (JSON.parse(row.transports) as never[]) : undefined,
    })),
    userVerification: "required",
    timeout: CHALLENGE_TTL_MS,
  });

  const record: ChallengeRecord = {
    id: crypto.randomUUID(),
    challenge: publicKey.challenge,
    userId: params.userId,
    kind: "authentication",
    label: null,
    expiresAtMs: nowMs + CHALLENGE_TTL_MS,
    consumed: false,
  };
  challenges.set(record.id, record);

  return { challengeId: record.id, publicKey, needsRecovery: false as const };
}

/**
 * Verifies an authentication assertion. Signature and credential-id match are
 * verified with the stored public key and the monotonic counter is enforced
 * and advanced - a cloned or replayed authenticator response fails.
 */
export async function verifyBreakGlassAssertion(
  params: { challengeId: string; response: unknown },
  db: AppDatabase = getAppDb(),
): Promise<{ userId: string }> {
  const record = challenges.get(params.challengeId);
  if (!record || record.kind !== "authentication" || record.consumed) {
    throw new Error("Unknown or expired authentication challenge.");
  }
  record.consumed = true;

  if (record.expiresAtMs <= Date.now()) {
    throw new Error("Authentication challenge expired.");
  }

  const response = params.response as { id?: string };
  const credentialRow =
    typeof response.id === "string"
      ? db
          .select()
          .from(webauthnCredentials)
          .where(eq(webauthnCredentials.id, response.id))
          .get()
      : undefined;

  if (!credentialRow || credentialRow.userId !== record.userId) {
    throw new Error("Assertion does not match an enrolled security key.");
  }

  const { origin, rpID } = resolveWebAuthnRelyingParty();
  const verification = await verifyAuthenticationResponse({
    response: params.response as never,
    expectedChallenge: record.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: credentialRow.id,
      publicKey: new Uint8Array(Buffer.from(credentialRow.publicKey, "base64")),
      counter: credentialRow.counter,
      transports: credentialRow.transports
        ? (JSON.parse(credentialRow.transports) as never[])
        : undefined,
    },
    requireUserVerification: true,
  });

  if (!verification.verified) {
    throw new Error("Security key assertion was not verified.");
  }

  db.update(webauthnCredentials)
    .set({
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date().toISOString(),
    })
    .where(eq(webauthnCredentials.id, credentialRow.id))
    .run();

  return { userId: record.userId };
}

export function issueBreakGlassCeremony(
  params: {
    userId: string;
    reason: string;
    sourceZone: string;
    via: "webauthn" | "recovery";
  },
  db: AppDatabase = getAppDb(),
): string {
  const id = crypto.randomUUID();
  db.insert(breakGlassCeremonies)
    .values({
      id,
      userId: params.userId,
      reason: params.reason,
      sourceZone: params.sourceZone,
      via: params.via,
      expiresAt: new Date(Date.now() + CEREMONY_TTL_MS).toISOString(),
      consumedAt: null,
    })
    .run();
  return id;
}

export function peekBreakGlassCeremony(
  id: string,
  db: AppDatabase = getAppDb(),
): BreakGlassCeremonyRecord | null {
  const record = db
    .select()
    .from(breakGlassCeremonies)
    .where(eq(breakGlassCeremonies.id, id))
    .get();
  if (!record || record.consumedAt !== null || Date.parse(record.expiresAt) <= Date.now()) {
    return null;
  }
  return record;
}

/** Atomically marks the ceremony consumed; only the first caller wins. */
export function consumeBreakGlassCeremony(
  id: string,
  db: AppDatabase = getAppDb(),
): BreakGlassCeremonyRecord | null {
  const record = peekBreakGlassCeremony(id, db);
  if (!record) {
    return null;
  }
  const result = db
    .update(breakGlassCeremonies)
    .set({ consumedAt: new Date().toISOString() })
    .where(
      and(eq(breakGlassCeremonies.id, id), isNull(breakGlassCeremonies.consumedAt)),
    )
    .run();
  return result.changes === 1 ? record : null;
}

// Rate limiting for emergency-access attempts: 5 failures lock 15 minutes.
const EMERGENCY_MAX_FAILURES = 5;
const EMERGENCY_LOCK_MS = 15 * 60 * 1000;
const emergencyAttempts = new Map<string, { failures: number; lockedUntilMs: number }>();

export function isEmergencyAttemptLocked(userId: string, now = new Date()) {
  const entry = emergencyAttempts.get(userId);
  if (!entry) {
    return false;
  }
  if (entry.lockedUntilMs > now.getTime()) {
    return true;
  }
  if (entry.lockedUntilMs > 0 && entry.lockedUntilMs <= now.getTime()) {
    emergencyAttempts.delete(userId);
  }
  return false;
}

export function recordFailedEmergencyAttempt(userId: string, now = new Date()) {
  const entry = emergencyAttempts.get(userId) ?? { failures: 0, lockedUntilMs: 0 };
  entry.failures += 1;
  if (entry.failures >= EMERGENCY_MAX_FAILURES) {
    entry.lockedUntilMs = now.getTime() + EMERGENCY_LOCK_MS;
    entry.failures = 0;
  }
  emergencyAttempts.set(userId, entry);
}

export function resetEmergencyAttempts(userId: string) {
  emergencyAttempts.delete(userId);
}
