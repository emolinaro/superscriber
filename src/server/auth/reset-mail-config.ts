import { AuthConfigError } from "@/server/auth/auth-config";

/**
 * Scoped reset-mail seam (spec section 3). Absent by default; when `smtp`,
 * delivers exactly one transactional template (password reset link). No other
 * code path receives a mailer handle. Secrets arrive as mounted file paths;
 * this loader never reads secret contents.
 */
export type ResetMailConfig =
  | { mode: "none" }
  | {
      mode: "smtp";
      host: string;
      port: number;
      fromAddress: string;
      username: string | null;
      passwordFile: string;
      baseUrl: string | null;
    };

export function loadResetMailConfig(
  env: Record<string, string | undefined> = process.env,
): ResetMailConfig {
  const raw = env.SUPERSCRIBER_RESET_MAIL_MODE?.trim();
  if (!raw || raw === "none") {
    return { mode: "none" };
  }
  if (raw !== "smtp") {
    throw new AuthConfigError(
      `SUPERSCRIBER_RESET_MAIL_MODE supports only unset, "none", or "smtp"; got "${raw}".`,
    );
  }

  const host = env.SUPERSCRIBER_RESET_MAIL_SMTP_HOST?.trim();
  const portRaw = env.SUPERSCRIBER_RESET_MAIL_SMTP_PORT?.trim();
  const fromAddress = env.SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS?.trim();
  const passwordFile = env.SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE?.trim();
  if (!host || !portRaw || !fromAddress || !passwordFile) {
    throw new AuthConfigError(
      "SUPERSCRIBER_RESET_MAIL_MODE=smtp requires SUPERSCRIBER_RESET_MAIL_SMTP_HOST, " +
        "SUPERSCRIBER_RESET_MAIL_SMTP_PORT, SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS, " +
        "and SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE.",
    );
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AuthConfigError(
      `SUPERSCRIBER_RESET_MAIL_SMTP_PORT must be an integer 1-65535; got "${portRaw}".`,
    );
  }
  return {
    mode: "smtp",
    host,
    port,
    fromAddress,
    username: env.SUPERSCRIBER_RESET_MAIL_USERNAME?.trim() || null,
    passwordFile,
    baseUrl: env.SUPERSCRIBER_RESET_MAIL_BASE_URL?.trim() || null,
  };
}
