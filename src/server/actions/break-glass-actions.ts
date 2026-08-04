"use server";

import { headers } from "next/headers";
import {
  beginEmergencyAccess,
  beginEmergencyRecovery,
  issueEmergencyCeremonyAfterAssertion,
} from "@/server/auth/emergency-access";
import { evaluateRequestZone } from "@/server/auth/management-network";
import {
  beginRegistrationChallenge,
  completeRegistration,
  verifyBreakGlassAssertion,
} from "@/server/auth/webauthn";
import {
  designateBreakGlassUser,
  generateBreakGlassRecoveryCodes,
  getBreakGlassDesignation,
} from "@/server/auth/break-glass";
import { getActivePrincipal } from "@/server/session";
import { getUserById } from "@/server/auth/service";

/**
 * Break-glass server actions. The emergency actions re-evaluate the trusted
 * management boundary on every call; failures are always generic.
 */

export async function beginEmergencyAccessAction(input: {
  password: string;
  reason: string;
}) {
  const zone = evaluateRequestZone(await headers());
  return beginEmergencyAccess({ ...input, zone });
}

export async function beginEmergencyRecoveryAction(input: {
  password: string;
  recoveryCode: string;
  reason: string;
}) {
  const zone = evaluateRequestZone(await headers());
  return beginEmergencyRecovery({ ...input, zone });
}

export async function completeEmergencyKeyAssertionAction(input: {
  challengeId: string;
  credential: unknown;
  reason: string;
}) {
  const zone = evaluateRequestZone(await headers());
  if (zone !== "management") {
    return { ok: false as const, error: "The emergency access request was not accepted." };
  }

  try {
    const { userId } = await verifyBreakGlassAssertion({
      challengeId: input.challengeId,
      response: input.credential,
    });
    const ceremonyToken = issueEmergencyCeremonyAfterAssertion({
      userId,
      reason: input.reason,
      zone,
    });
    return { ok: true as const, ceremonyToken };
  } catch {
    return { ok: false as const, error: "The emergency access request was not accepted." };
  }
}

async function requireAdmin() {
  const principal = await getActivePrincipal();
  if (!principal || principal.role !== "admin") {
    throw new Error("Only admin accounts can manage emergency access.");
  }
  return principal;
}

export async function designateBreakGlassAdminAction(input: {
  userId: string;
  changeReason: string;
}) {
  const principal = await requireAdmin();

  if (getBreakGlassDesignation()) {
    return {
      ok: false as const,
      error:
        "A break-glass designation already exists; transfer it via the operator ceremony in the runbook.",
    };
  }

  designateBreakGlassUser({
    userId: input.userId,
    actorUserId: principal.userId,
    changeReason: input.changeReason,
  });
  return { ok: true as const };
}

export async function beginBreakGlassKeyEnrollmentAction(input: { label: string }) {
  const principal = await requireAdmin();

  const designation = getBreakGlassDesignation();
  if (!designation) {
    return { ok: false as const, error: "Designate the break-glass account first." };
  }
  if (principal.userId !== designation.breakGlassUserId) {
    return {
      ok: false as const,
      error: "Only the designated break-glass custodian can enroll security keys.",
    };
  }

  const designee = await getUserById(designation.breakGlassUserId);
  if (!designee) {
    return { ok: false as const, error: "The designated account is unavailable." };
  }

  const challenge = await beginRegistrationChallenge({
    userId: designee.id,
    userName: designee.email,
    userDisplayName: designee.displayName,
    label: input.label,
  });

  return {
    ok: true as const,
    challengeId: challenge.challengeId,
    publicKey: challenge.publicKey as unknown as Record<string, unknown>,
  };
}

export async function completeBreakGlassKeyEnrollmentAction(input: {
  challengeId: string;
  credential: unknown;
  label: string;
}) {
  const principal = await requireAdmin();

  const designation = getBreakGlassDesignation();
  if (!designation) {
    return { ok: false as const, error: "Designate the break-glass account first." };
  }
  if (principal.userId !== designation.breakGlassUserId) {
    return {
      ok: false as const,
      error: "Only the designated break-glass custodian can enroll security keys.",
    };
  }

  try {
    const result = await completeRegistration({
      challengeId: input.challengeId,
      response: input.credential,
      label: input.label,
    });

    const { recordSecurityEvent } = await import("@/server/auth/security-events");
    recordSecurityEvent({
      type: "breakglass.key_enrolled",
      outcome: "success",
      userId: designation.breakGlassUserId,
      detail: "Break-glass security key enrolled.",
      metadata: { actorUserId: principal.userId, credentialIdSuffix: result.credentialId.slice(-6) },
    });

    return { ok: true as const, credentialId: result.credentialId };
  } catch {
    return { ok: false as const, error: "Security key enrollment was not verified." };
  }
}

export async function rotateBreakGlassRecoveryCodesAction() {
  const principal = await requireAdmin();

  const designation = getBreakGlassDesignation();
  if (!designation) {
    return { ok: false as const, error: "Designate the break-glass account first." };
  }
  if (principal.userId !== designation.breakGlassUserId) {
    return {
      ok: false as const,
      error: "Only the designated break-glass custodian can rotate recovery codes.",
    };
  }

  const { codes } = generateBreakGlassRecoveryCodes({
    userId: designation.breakGlassUserId,
    actorUserId: principal.userId,
  });

  // Codes are returned exactly once to the operator and never persisted
  // outside their hashes.
  return { ok: true as const, codes };
}
