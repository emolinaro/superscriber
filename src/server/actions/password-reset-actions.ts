"use server";

import { headers } from "next/headers";
import {
  PASSWORD_RESET_COPY,
  passwordResetRequestSchema,
} from "@/lib/password-reset";
import { resolveClientIp } from "@/server/auth/management-network";
import {
  requestConfirmationCopy,
  requestPasswordReset,
} from "@/server/auth/password-reset";

export type PasswordResetRequestActionResult =
  | { ok: true; message: string }
  | { ok: false; fieldErrors: { email?: string } };

/** Client IP and origin for rate limiting and reset-link construction. */
export async function requestContext() {
  const headerList = await headers();
  const configuredBase = process.env.SUPERSCRIBER_RESET_MAIL_BASE_URL?.trim();
  const host = headerList.get("host");
  const proto = headerList.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const scheme = proto === "http" || proto === "https" ? proto : "https";
  const origin =
    configuredBase || headerList.get("origin") || (host ? `${scheme}://${host}` : null);
  return { ip: resolveClientIp(headerList), origin };
}

export async function requestPasswordResetAction(input: {
  email: string;
}): Promise<PasswordResetRequestActionResult> {
  const parsed = passwordResetRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: { email: parsed.error.flatten().fieldErrors.email?.[0] },
    };
  }
  const { ip, origin } = await requestContext();
  await requestPasswordReset({ email: parsed.data.email, ip, origin });
  // Anti-enumeration: within a posture the confirmation is identical for every
  // accepted submission; only the instance mail posture changes the copy.
  return { ok: true, message: requestConfirmationCopy() };
}

import { completePasswordReset } from "@/server/auth/password-reset";
import { passwordResetCompletionSchema } from "@/lib/password-reset";

export type CompletePasswordResetActionResult =
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<"password" | "confirmPassword", string>>;
    };

export async function completePasswordResetAction(input: {
  token: string;
  password: string;
  confirmPassword: string;
}): Promise<CompletePasswordResetActionResult> {
  const parsed = passwordResetCompletionSchema.safeParse(input);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    return {
      ok: false,
      message:
        flat.fieldErrors.password?.[0] ??
        flat.fieldErrors.confirmPassword?.[0] ??
        "Check the form and try again.",
      fieldErrors: {
        password: flat.fieldErrors.password?.[0],
        confirmPassword: flat.fieldErrors.confirmPassword?.[0],
      },
    };
  }
  const { ip } = await requestContext();
  const result = await completePasswordReset({
    rawToken: parsed.data.token,
    password: parsed.data.password,
    ip,
  });
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  return { ok: true, message: PASSWORD_RESET_COPY.REDEEM_SUCCESS };
}
