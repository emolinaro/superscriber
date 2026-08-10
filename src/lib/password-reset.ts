import { z } from "zod";

export const PASSWORD_RESET_COPY = {
  REQUEST_CONFIRMATION:
    "If an account matches that email, a password reset has been started. If nothing arrives, contact your administrator.",
  REDEEM_FAILURE:
    "That reset link is no longer valid. Ask your administrator for a new one or request another reset.",
  REDEEM_SUCCESS: "Your password has been reset. Sign in with your new password.",
} as const;

export const passwordResetRequestSchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(320),
});

export const passwordResetCompletionSchema = z
  .object({
    token: z.string().min(1),
    password: z
      .string()
      .min(10, "Use at least 10 characters.")
      .max(200, "Passwords must stay under 200 characters."),
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
