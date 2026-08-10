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
