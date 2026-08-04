import { loadAuthConfig } from "@/server/auth/auth-config";
import {
  EMERGENCY_REASON_MAX,
  EMERGENCY_REASON_MIN,
  getBreakGlassDesignation,
  useBreakGlassRecoveryCode,
  verifyBreakGlassPassword,
} from "@/server/auth/break-glass";
import { recordSecurityEvent } from "@/server/auth/security-events";
import {
  beginAuthenticationChallenge,
  isEmergencyAttemptLocked,
  issueBreakGlassCeremony,
  recordFailedEmergencyAttempt,
  resetEmergencyAttempts,
} from "@/server/auth/webauthn";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import type { SourceZone } from "@/server/auth/management-network";

/**
 * Emergency (break-glass) access orchestration (plan section 8). Pure service
 * so unit tests can drive the full denial matrix without HTTP. Denials use
 * one generic message and a redacted security event with a coarse reason.
 */

export type EmergencyBeginResult =
  | { ok: true; challengeId: string; publicKey: Record<string, unknown> }
  | { ok: true; needsRecovery: true }
  | { ok: true; ceremonyToken: string }
  | { ok: false; error: string };

const GENERIC_DENIAL = "The emergency access request was not accepted.";

function deny(
  reason: string,
  userId: string | null,
  zone: SourceZone,
  db: AppDatabase,
): EmergencyBeginResult {
  try {
    recordSecurityEvent(
      {
        type: "breakglass.emergency_denied",
        outcome: "denied",
        userId,
        sourceZone: zone,
        detail: "Emergency access denied.",
        metadata: { reason },
      },
      db,
    );
  } catch {
    // Denial reporting must never mask the denial itself.
  }
  return { ok: false, error: GENERIC_DENIAL };
}

export async function beginEmergencyAccess(
  input: {
    password: string;
    reason: string;
    zone: SourceZone;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): Promise<EmergencyBeginResult> {
  const zone = input.zone;
  const config = loadAuthConfig();

  if (config.mode === "local") {
    return deny("mode_not_emergency_capable", null, zone, db);
  }

  if (zone !== "management") {
    return deny("untrusted_source", null, zone, db);
  }

  const designation = getBreakGlassDesignation(db);
  if (!designation) {
    return deny("no_designation", null, zone, db);
  }

  const userId = designation.breakGlassUserId;

  if (isEmergencyAttemptLocked(userId, input.now)) {
    return deny("temporarily_locked", userId, zone, db);
  }

  if (
    input.reason.length < EMERGENCY_REASON_MIN ||
    input.reason.length > EMERGENCY_REASON_MAX
  ) {
    return deny("invalid_reason", userId, zone, db);
  }

  const passwordOk = await verifyBreakGlassPassword({ userId, password: input.password }, db);
  if (!passwordOk) {
    recordFailedEmergencyAttempt(userId, input.now);
    return deny("authentication_failed", userId, zone, db);
  }

  resetEmergencyAttempts(userId);

  const challenge = await beginAuthenticationChallenge({ userId }, db, { now: input.now });
  if (challenge.needsRecovery) {
    return { ok: true, needsRecovery: true };
  }

  return {
    ok: true,
    challengeId: challenge.challengeId!,
    publicKey: challenge.publicKey as unknown as Record<string, unknown>,
  };
}

export async function beginEmergencyRecovery(
  input: {
    password: string;
    recoveryCode: string;
    reason: string;
    zone: SourceZone;
    now?: Date;
  },
  db: AppDatabase = getAppDb(),
): Promise<EmergencyBeginResult> {
  const zone = input.zone;
  const config = loadAuthConfig();
  if (config.mode === "local") {
    return deny("mode_not_emergency_capable", null, zone, db);
  }
  if (zone !== "management") {
    return deny("untrusted_source", null, zone, db);
  }

  const designation = getBreakGlassDesignation(db);
  if (!designation) {
    return deny("no_designation", null, zone, db);
  }

  const userId = designation.breakGlassUserId;
  if (isEmergencyAttemptLocked(userId, input.now)) {
    return deny("temporarily_locked", userId, zone, db);
  }

  if (
    input.reason.length < EMERGENCY_REASON_MIN ||
    input.reason.length > EMERGENCY_REASON_MAX
  ) {
    return deny("invalid_reason", userId, zone, db);
  }

  const passwordOk = await verifyBreakGlassPassword({ userId, password: input.password }, db);
  const codeOk = passwordOk
    ? useBreakGlassRecoveryCode({ userId, code: input.recoveryCode, now: input.now }, db)
    : false;

  if (!passwordOk || !codeOk) {
    recordFailedEmergencyAttempt(userId, input.now);
    return deny("authentication_failed", userId, zone, db);
  }

  resetEmergencyAttempts(userId);
  const ceremonyToken = issueBreakGlassCeremony(
    {
      userId,
      reason: input.reason,
      sourceZone: zone,
      via: "recovery",
    },
    db,
  );
  return { ok: true, ceremonyToken };
}

/**
 * Called after a verified WebAuthn assertion to issue the one-time ceremony
 * token consumed by the Auth.js credentials callback.
 */
export function issueEmergencyCeremonyAfterAssertion(
  input: {
    userId: string;
    reason: string;
    zone: SourceZone;
  },
  db?: Parameters<typeof issueBreakGlassCeremony>[1],
) {
  return issueBreakGlassCeremony(
    {
      userId: input.userId,
      reason: input.reason,
      sourceZone: input.zone,
      via: "webauthn",
    },
    db,
  );
}


