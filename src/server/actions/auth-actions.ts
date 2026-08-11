"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { type BootstrapFormState, type RecoveryClaimFormState } from "@/lib/auth-forms";
import { loadAuthConfig } from "@/server/auth/auth-config";
import { authOptions } from "@/server/auth/options";
import {
  createRecoveryAdmin,
  RecoveryClaimError,
  recoveryClaimLimiter,
} from "@/server/auth/recovery-claim";
import { evaluateRequestZone, resolveClientIp } from "@/server/auth/management-network";
import { recordSecurityEvent } from "@/server/auth/security-events";
import {
  createBootstrapAdmin as createBootstrapAdminAccount,
  hasAnyActiveAdmin,
  hasAnyUsers,
} from "@/server/auth/service";
import { revokeAuthSession } from "@/server/auth/session-registry";
import {
  bootstrapAdminSchema,
  normalizeEmail,
  recoveryAdminClaimSchema,
} from "@/server/auth/validation";

const BOOTSTRAP_EMAIL_COOKIE = "superscriber.bootstrap-email";

/**
 * Plan section 6.4.1: logout revokes the current durable session row before
 * the cookie clear. Failure must never keep a user signed in, so this action
 * always resolves; the client proceeds to clear the cookie regardless.
 */
export async function revokeCurrentSessionAction(): Promise<{ ok: true }> {
  try {
    const session = await getServerSession(authOptions);
    if (session?.authSessionId && session.user?.id) {
      revokeAuthSession(session.authSessionId, "logout");
    }
  } catch {
    // Cookie clear proceeds regardless.
  }

  return { ok: true };
}

function asString(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  return typeof value === "string" ? value : fallback;
}

function mapBootstrapFieldErrors(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const errors: BootstrapFormState["fieldErrors"] = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (
      key === "displayName" ||
      key === "email" ||
      key === "password" ||
      key === "confirmPassword"
    ) {
      errors[key] = issue.message;
    }
  }

  return errors;
}

function mapRecoveryClaimFieldErrors(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const errors: RecoveryClaimFormState["fieldErrors"] = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (
      key === "displayName" ||
      key === "email" ||
      key === "password" ||
      key === "confirmPassword" ||
      key === "claimToken"
    ) {
      errors[key] = issue.message;
    }
  }

  return errors;
}

export async function createBootstrapAdminAction(
  _previousState: BootstrapFormState,
  formData: FormData,
): Promise<BootstrapFormState> {
  const values = {
    displayName: asString(formData, "displayName"),
    email: asString(formData, "email"),
  };

  if (await hasAnyUsers()) {
    return {
      formError: "First-run setup is already complete. Sign in with an existing account.",
      values,
    };
  }

  const parsed = bootstrapAdminSchema.safeParse({
    displayName: values.displayName,
    email: values.email,
    password: asString(formData, "password"),
    confirmPassword: asString(formData, "confirmPassword"),
  });

  if (!parsed.success) {
    return {
      formError: "Review the highlighted fields and try again.",
      fieldErrors: mapBootstrapFieldErrors(parsed.error.issues),
      values,
    };
  }

  try {
    await createBootstrapAdminAccount({
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      password: parsed.data.password,
    });
  } catch (error) {
    return {
      formError:
        error instanceof Error
          ? error.message
          : "The first administrator account could not be created.",
      values,
    };
  }

  const cookieStore = await cookies();
  cookieStore.set(BOOTSTRAP_EMAIL_COOKIE, normalizeEmail(parsed.data.email), {
    httpOnly: true,
    maxAge: 60,
    path: "/",
    sameSite: "strict",
  });

  redirect("/?notice=bootstrap-complete");
}

/**
 * Unmanageable-instance recovery claim (captain ruling, admin-bootstrap
 * recovery). Gates, in order: accounts must exist (first-run owns the
 * zero-account case), no active administrator may remain, the auth mode must
 * let a local admin actually sign in afterwards, and the attempt must fit
 * the brute-force budget before the operator claim token is even consulted.
 * Every refused attempt that reaches the claim is audited without the
 * attempted token; success is audited against the new admin id.
 */
export async function claimRecoveryAdminAction(
  _previousState: RecoveryClaimFormState,
  formData: FormData,
): Promise<RecoveryClaimFormState> {
  const values = {
    displayName: asString(formData, "displayName"),
    email: asString(formData, "email"),
  };

  if (!(await hasAnyUsers())) {
    return {
      formError:
        "No accounts exist on this appliance. Use first-run setup to create the first administrator.",
      values,
    };
  }

  if (await hasAnyActiveAdmin()) {
    return {
      formError: "An active administrator already exists. Sign in with an existing account.",
      values,
    };
  }

  if (loadAuthConfig().mode === "authentik-primary") {
    // A locally claimed admin cannot sign in where institutional sign-in is
    // primary; the break-glass ceremony is the supported recovery there.
    return {
      formError:
        "This appliance uses institutional sign-in. Recover access with the break-glass ceremony in the operator runbook.",
      values,
    };
  }

  const parsed = recoveryAdminClaimSchema.safeParse({
    displayName: values.displayName,
    email: values.email,
    password: asString(formData, "password"),
    confirmPassword: asString(formData, "confirmPassword"),
    claimToken: asString(formData, "claimToken"),
  });

  if (!parsed.success) {
    return {
      formError: "Review the highlighted fields and try again.",
      fieldErrors: mapRecoveryClaimFieldErrors(parsed.error.issues),
      values,
    };
  }

  const requestHeaders = await headers();
  const sourceZone = evaluateRequestZone(requestHeaders);
  const budget = recoveryClaimLimiter.check(resolveClientIp(requestHeaders) ?? "unknown");
  if (!budget.allowed) {
    recordSecurityEvent({
      type: "admin.recovery_claim",
      outcome: "denied",
      sourceZone,
      detail: "Recovery administrator claim refused: rate limit exhausted.",
    });
    return {
      formError: "Too many administrator claim attempts. Wait a few minutes and try again.",
      values,
    };
  }

  let claimed;
  try {
    claimed = await createRecoveryAdmin({
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      password: parsed.data.password,
      claimToken: parsed.data.claimToken,
    });
  } catch (error) {
    if (error instanceof RecoveryClaimError) {
      if (error.code === "email_taken") {
        return {
          formError: "Review the highlighted fields and try again.",
          fieldErrors: { email: "An account with that email already exists." },
          values,
        };
      }
      if (error.code === "admin_exists" || error.code === "requires_existing_users") {
        // Lost a state race (concurrent claim or mid-claim administration):
        // the store truth wins and the surface flips on the next render.
        return { formError: error.message, values };
      }
      recordSecurityEvent({
        type: "admin.recovery_claim",
        outcome: "denied",
        sourceZone,
        detail: "Recovery administrator claim refused.",
      });
      return {
        formError:
          "The administrator claim was not accepted. Check the operator claim token and try again.",
        fieldErrors: {
          claimToken: "The claim token did not match the proof on the appliance host.",
        },
        values,
      };
    }
    throw error;
  }

  recordSecurityEvent({
    type: "admin.recovery_claim",
    outcome: "success",
    userId: claimed.id,
    sourceZone,
    detail: "Recovery administrator claim completed.",
  });

  const cookieStore = await cookies();
  cookieStore.set(BOOTSTRAP_EMAIL_COOKIE, normalizeEmail(claimed.email), {
    httpOnly: true,
    maxAge: 60,
    path: "/",
    sameSite: "strict",
  });

  redirect("/?notice=admin-recovery-complete");
}

export async function consumeBootstrapEmailAction() {
  const cookieStore = await cookies();
  cookieStore.set(BOOTSTRAP_EMAIL_COOKIE, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "strict",
  });
}
