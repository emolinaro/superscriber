"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { type BootstrapFormState } from "@/lib/auth-forms";
import { authOptions } from "@/server/auth/options";
import { createBootstrapAdmin as createBootstrapAdminAccount, hasAnyUsers } from "@/server/auth/service";
import { revokeAuthSession } from "@/server/auth/session-registry";
import { bootstrapAdminSchema, normalizeEmail } from "@/server/auth/validation";

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
