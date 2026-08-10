import { z } from "zod";

const REASON_MESSAGE = "Enter a reset reason between 10 and 500 characters.";

export const PASSWORD_RESET_ADMIN_COPY = {
  ACCESS_DENIED: "Only an active administrator with a live session can reset account passwords.",
  NOT_FOUND: "That account no longer exists.",
  INACTIVE_TARGET: "Inactive accounts cannot be reset.",
  BREAK_GLASS_DESIGNEE:
    "The break-glass administrator's password rotates only through the emergency ceremony.",
  CREDENTIAL_DISABLED:
    "That account's local credential was retired by a break-glass transfer and cannot be reset here.",
  MAIL_UNCONFIGURED: "Reset mail is not configured. Choose out-of-band handoff instead.",
  INTERNAL_ERROR: "The password reset could not be completed. Try again.",
  MAIL_SEND_FAILED:
    "The reset was issued but the email could not be delivered. Re-issue with out-of-band handoff.",
  VALIDATION_ERROR: "Check the form and try again.",
} as const;

export const adminPasswordResetInputSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().min(10, REASON_MESSAGE).max(500, REASON_MESSAGE),
  delivery: z.enum(["operator_handoff", "email"]),
});

export type AdminPasswordResetInput = z.infer<typeof adminPasswordResetInputSchema>;
