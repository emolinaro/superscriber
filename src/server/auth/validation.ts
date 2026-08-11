import { z } from "zod";
import { USER_ROLES } from "@/domain/models";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export const loginCredentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

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

export const bootstrapAdminSchema = localUserSchema
  .pick({
    displayName: true,
    email: true,
    password: true,
  })
  .extend({
    confirmPassword: z.string().min(1, "Confirm the password."),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmPassword) {
      context.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords must match.",
      });
    }
  });

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
    confirmPassword: z.string().min(1, "Confirm the password."),
    claimToken: z.string().min(1, "Enter the operator claim token from the appliance host."),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmPassword) {
      context.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords must match.",
      });
    }
  });
