import { readFileSync } from "node:fs";
import { createTransport } from "nodemailer";
import type { ResetMailConfig } from "@/server/auth/reset-mail-config";

export type SmtpResetMailConfig = Extract<ResetMailConfig, { mode: "smtp" }>;

/**
 * The only transactional template this deployment can send (spec section 3):
 * the reset URL, absolute expiry, and a pointer to the administrator.
 */
export function buildResetMailMessage(params: { resetUrl: string; expiresAtIso: string }) {
  return {
    subject: "Superscriber password reset",
    text: [
      "A password reset was started for your Superscriber account.",
      "",
      `This single-use link expires at ${params.expiresAtIso}:`,
      params.resetUrl,
      "",
      "If you did not request this, or the link no longer works, contact your administrator.",
    ].join("\n"),
  };
}

export async function sendPasswordResetEmail(
  config: SmtpResetMailConfig,
  params: { to: string; resetUrl: string; expiresAtIso: string },
): Promise<void> {
  const password = readFileSync(config.passwordFile, "utf8").trim();
  const message = buildResetMailMessage(params);
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.username ?? config.fromAddress, pass: password },
  });
  await transporter.sendMail({
    from: config.fromAddress,
    to: params.to,
    subject: message.subject,
    text: message.text,
  });
}
