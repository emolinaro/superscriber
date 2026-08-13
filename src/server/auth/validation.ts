import { z } from "zod";
import { USER_ROLES } from "@/domain/models";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export const loginCredentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export const PASSWORD_MISMATCH_MESSAGE = "Passwords must match.";

const confirmPasswordField = z.string().min(1, "Confirm the password.");

function requirePasswordMatch(
  value: { password: string; confirmPassword: string },
  context: z.RefinementCtx,
) {
  if (value.password !== value.confirmPassword) {
    context.addIssue({
      code: "custom",
      path: ["confirmPassword"],
      message: PASSWORD_MISMATCH_MESSAGE,
    });
  }
}

export const localUserSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, "Enter the user's name.")
    .max(80, "Names must stay under 80 characters."),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .max(320, "Email addresses must stay under 320 characters."),
  password: z
    .string()
    .min(10, "Use at least 10 characters.")
    .max(200, "Passwords must stay under 200 characters."),
  role: z.enum(USER_ROLES),
});

/**
 * Admin-provisioned local account: the confirmation travels with the input so
 * the server re-checks the match, but it is never persisted or forwarded past
 * this schema. Consumers must strip it before calling account services.
 */
export const localUserWithConfirmationSchema = localUserSchema
  .extend({
    confirmPassword: confirmPasswordField,
  })
  .superRefine(requirePasswordMatch);

export const bootstrapAdminSchema = localUserSchema
  .pick({
    displayName: true,
    email: true,
    password: true,
  })
  .extend({
    confirmPassword: confirmPasswordField,
  })
  .superRefine(requirePasswordMatch);

/**
 * Unmanageable-instance recovery claim: same account fields as first-run
 * bootstrap plus the operator claim token that gates the ceremony.
 */
export const recoveryAdminClaimSchema = localUserSchema
  .pick({
    displayName: true,
    email: true,
    password: true,
  })
  .extend({
    confirmPassword: confirmPasswordField,
    claimToken: z.string().min(1, "Enter the operator claim token from the appliance host."),
  })
  .superRefine(requirePasswordMatch);
