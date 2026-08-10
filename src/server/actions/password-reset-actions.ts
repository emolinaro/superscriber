"use server";

import { headers } from "next/headers";
import {
  PASSWORD_RESET_COPY,
  passwordResetRequestSchema,
} from "@/lib/password-reset";
import { requestPasswordReset } from "@/server/auth/password-reset";

export type PasswordResetRequestActionResult =
  | { ok: true; message: string }
  | { ok: false; fieldErrors: { email?: string } };

/** Client IP and origin for rate limiting and reset-link construction. */
export async function requestContext() {
  const headerList = await headers();
  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  const host = headerList.get("host");
  const origin = headerList.get("origin") ?? (host ? `https://${host}` : null);
  return { ip: forwarded ?? null, origin };
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
  // Anti-enumeration: identical confirmation for every accepted submission.
  return { ok: true, message: PASSWORD_RESET_COPY.REQUEST_CONFIRMATION };
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
