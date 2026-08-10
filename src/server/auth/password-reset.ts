import { compare, hash } from "bcryptjs";
import { loadAuthConfig } from "@/server/auth/auth-config";
import { loadResetMailConfig } from "@/server/auth/reset-mail-config";
import { sendPasswordResetEmail } from "@/server/auth/reset-mailer";
import { recordSecurityEvent } from "@/server/auth/security-events";
import {
  resetRequestByEmailLimiter,
  resetRequestByIpLimiter,
} from "@/server/auth/password-reset-rate-limit";
import {
  checkSelfServiceEligibility,
  issueResetToken,
} from "@/server/auth/password-reset-tokens";
import { normalizeEmail } from "@/server/auth/validation";
import { getAppDb, type AppDatabase } from "@/server/db/client";

const DUMMY_PASSWORD = "superscriber-reset-dummy-guess";
let dummyHashPromise: Promise<string> | null = null;

/** Constant-shape work for ineligible requests (spec 4.4). */
async function dummyCompare() {
  dummyHashPromise ??= hash("superscriber-reset-dummy", 12);
  await compare(DUMMY_PASSWORD, await dummyHashPromise);
}

function safeRecord(input: Parameters<typeof recordSecurityEvent>[0], db: AppDatabase) {
  try {
    recordSecurityEvent(input, db);
  } catch {
    // The reset flow never fails because its event stream did.
  }
}

export function buildResetUrl(rawToken: string, origin: string | null, baseUrl: string | null) {
  const base = (baseUrl ?? origin ?? "").replace(/\/$/, "");
  return `${base}/reset/${rawToken}`;
}

/**
 * Self-service request (spec section 4). Always resolves; the caller returns
 * PASSWORD_RESET_COPY.REQUEST_CONFIRMATION regardless of outcome.
 */
export async function requestPasswordReset(
  params: { email: string; ip: string | null; origin: string | null },
  db: AppDatabase = getAppDb(),
): Promise<void> {
  const email = normalizeEmail(params.email);

  const byIp = resetRequestByIpLimiter.check(params.ip ?? "unknown");
  const byEmail = resetRequestByEmailLimiter.check(email);
  if (!byIp.allowed || !byEmail.allowed) {
    await dummyCompare();
    safeRecord(
      {
        type: "password.reset.requested",
        outcome: "denied",
        detail: "Password reset request rate limited.",
        metadata: { reason: "rate_limited" },
      },
      db,
    );
    return;
  }

  const authMode = loadAuthConfig().mode;
  const eligibility = checkSelfServiceEligibility(email, db);
  if (authMode === "authentik-primary" || !eligibility.eligible) {
    await dummyCompare();
    safeRecord(
      {
        type: "password.reset.requested",
        outcome: "denied",
        detail: "Password reset request denied.",
        metadata: {
          reason:
            authMode === "authentik-primary"
              ? "authentik_primary_mode"
              : !eligibility.eligible
                ? eligibility.reason
                : "unknown_or_ineligible",
        },
      },
      db,
    );
    return;
  }

  const config = loadResetMailConfig();
  if (config.mode === "none") {
    safeRecord(
      {
        type: "password.reset.requested",
        outcome: "success",
        userId: eligibility.userId,
        detail: "Password reset request accepted; mail seam unconfigured.",
        metadata: { delivery: "unconfigured" },
      },
      db,
    );
    return;
  }

  const issued = issueResetToken(
    { userId: eligibility.userId, source: "self_service", delivery: "email" },
    db,
  );
  const resetUrl = buildResetUrl(issued.rawToken, params.origin, config.baseUrl);
  safeRecord(
    {
      type: "password.reset.requested",
      outcome: "success",
      userId: eligibility.userId,
      detail: "Password reset link emailed.",
      metadata: { delivery: "email", resetRecordId: issued.tokenId },
    },
    db,
  );
  try {
    await sendPasswordResetEmail(config, {
      to: eligibility.email,
      resetUrl,
      expiresAtIso: issued.expiresAt,
    });
  } catch {
    // Honest degradation: the token stays valid; the failure is visible to
    // admins on the security-event surface, not to the requester.
    safeRecord(
      {
        type: "password.reset.mail_failed",
        outcome: "error",
        userId: eligibility.userId,
        detail: "Password reset mail could not be delivered.",
        metadata: { resetRecordId: issued.tokenId },
      },
      db,
    );
  }
}
