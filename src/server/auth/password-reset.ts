import { compare, hash } from "bcryptjs";
import { AuthConfigError, loadAuthConfig } from "@/server/auth/auth-config";
import {
  loadResetMailConfig,
  type ResetMailConfig,
} from "@/server/auth/reset-mail-config";
import { sendPasswordResetEmail } from "@/server/auth/reset-mailer";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { normalizeEmail } from "@/server/auth/validation";
import {
  resetRedeemByIpLimiter,
  resetRequestByEmailLimiter,
  resetRequestByIpLimiter,
} from "@/server/auth/password-reset-rate-limit";
import {
  checkSelfServiceEligibility,
  invalidateUserResetTokens,
  issueResetToken,
  loadRedeemableToken,
  markResetTokenUsed,
} from "@/server/auth/password-reset-tokens";
import { retireUserSessions } from "@/server/auth/session-registry";
import { PASSWORD_RESET_COPY } from "@/lib/password-reset";
import {
  getAppDb,
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { runImmediateGovernedTransaction } from "@/server/db/transaction";
import { eq } from "drizzle-orm";
import { authControl, users } from "@/server/db/schema";

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
 * Confirmation copy for the self-service request (spec 4.4, captain-amended).
 * The copy varies only with the instance-wide reset-mail posture, never with
 * the submitted email, so known and unknown accounts stay byte-identical
 * within a posture and enumeration stays impossible. Instance posture is not
 * a secret: the readiness surface already reports operator-assisted versus
 * configured, and loadResetMailConfig performs constant env reads (it never
 * opens the mounted secret file), so selection adds no per-account timing
 * signal. Anything that cannot deliver - unset, none, or misconfigured -
 * answers honestly that nothing was sent; only a working smtp seam earns the
 * "a password reset has been started" claim.
 */
export function requestConfirmationCopy(
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    return loadResetMailConfig(env).mode === "smtp"
      ? PASSWORD_RESET_COPY.REQUEST_CONFIRMATION
      : PASSWORD_RESET_COPY.REQUEST_CONFIRMATION_NO_MAIL;
  } catch (error) {
    if (!(error instanceof AuthConfigError)) {
      throw error;
    }
    // Misconfigured still delivers nothing; readiness shows the operator why.
    return PASSWORD_RESET_COPY.REQUEST_CONFIRMATION_NO_MAIL;
  }
}

/**
 * Self-service request (spec section 4). Always resolves; the caller returns
 * requestConfirmationCopy() regardless of outcome, so per-account results
 * never change the copy - only the instance mail posture does.
 */
export async function requestPasswordReset(
  params: { email: string; ip: string | null; origin: string | null },
  db: AppDatabase = getAppDb(),
): Promise<void> {
  const email = normalizeEmail(params.email);

  const byIp = resetRequestByIpLimiter.check(params.ip ?? "unknown");
  if (!byIp.allowed) {
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

  let config: ResetMailConfig;
  try {
    config = loadResetMailConfig();
  } catch (error) {
    if (!(error instanceof AuthConfigError)) {
      throw error;
    }
    await dummyCompare();
    safeRecord(
      {
        type: "password.reset.requested",
        outcome: "error",
        userId: eligibility.userId,
        detail: "Password reset request accepted; mail seam misconfigured.",
        metadata: { delivery: "misconfigured" },
      },
      db,
    );
    return;
  }
  if (config.mode === "none") {
    await dummyCompare();
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

  if (!resetRequestByEmailLimiter.check(email).allowed) {
    await dummyCompare();
    safeRecord(
      {
        type: "password.reset.requested",
        outcome: "denied",
        userId: eligibility.userId,
        detail: "Password reset request rate limited.",
        metadata: { reason: "rate_limited" },
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

class RedeemStateChangedError extends Error {}

/**
 * Completion (spec 4.1): one transaction - mark used, write bcrypt(12) hash,
 * retire every session from every auth source via auth_version advancement,
 * invalidate leftover tokens. Never mints a session; never auto-signs-in.
 */
export async function completePasswordReset(
  params: { rawToken: string; password: string; ip: string | null },
  bundle: AppDatabaseBundle = getAppDbBundle(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const deny = (reason: string) => {
    safeRecord(
      {
        type: "password.reset.redeem_denied",
        outcome: "denied",
        detail: "Password reset redemption denied.",
        metadata: { reason },
      },
      bundle.db,
    );
    return { ok: false as const, message: PASSWORD_RESET_COPY.REDEEM_FAILURE };
  };

  if (!resetRedeemByIpLimiter.check(params.ip ?? "unknown").allowed) {
    return deny("rate_limited");
  }

  const redeemable = loadRedeemableToken(params.rawToken, bundle.db);
  if (!redeemable.ok) {
    return deny(redeemable.reason);
  }

  const passwordHash = await hash(params.password, 12);

  try {
    runImmediateGovernedTransaction((db, nowIso) => {
      const current = loadRedeemableToken(params.rawToken, db, new Date(nowIso));
      if (!current.ok) {
        throw new RedeemStateChangedError("state_changed");
      }
      // Defense in depth: a token issued before designation must never reset
      // the break-glass credential outside the emergency ceremony.
      const designation = db
        .select({ userId: authControl.breakGlassUserId })
        .from(authControl)
        .where(eq(authControl.id, 1))
        .get();
      if (designation?.userId === current.token.userId) {
        throw new RedeemStateChangedError("break_glass_designee");
      }
      const target = db
        .select({ isActive: users.isActive, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, current.token.userId))
        .get();
      if (!target || !target.isActive) {
        throw new RedeemStateChangedError("inactive_target");
      }
      if (target.passwordHash?.startsWith("disabled:")) {
        throw new RedeemStateChangedError("credential_disabled");
      }
      markResetTokenUsed(current.token.id, db, nowIso);
      db.update(users)
        .set({ passwordHash, updatedAt: nowIso })
        .where(eq(users.id, current.token.userId))
        .run();
      retireUserSessions({ userId: current.token.userId, reason: "password_reset" }, db);
      invalidateUserResetTokens(
        { userId: current.token.userId, reason: "user_reset_completed" },
        db,
        nowIso,
      );
      recordSecurityEvent(
        {
          type: "password.reset.completed",
          outcome: "success",
          userId: current.token.userId,
          detail: "Password reset completed; sessions revoked.",
          metadata: { source: current.token.source, resetRecordId: current.token.id },
        },
        db,
      );
      return null;
    }, bundle);
  } catch (error) {
    if (error instanceof RedeemStateChangedError) {
      return deny(error.message || "state_changed");
    }
    throw error;
  }

  return { ok: true };
}
