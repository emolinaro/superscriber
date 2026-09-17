import { z } from "zod";
import { localUserSchema } from "@/server/auth/validation";

export const accountReasonSchema = z
  .string()
  .trim()
  .min(1, "Enter a reason for this account action.")
  .max(500, "Keep the reason under 500 characters.");
export const accountLifecycleInputSchema = z.object({
  userId: z.string().min(1),
  action: z.enum(["deactivate", "reactivate", "remove"]),
  expectedIsActive: z.boolean(),
  reason: accountReasonSchema,
});
export const temporaryAccountInputSchema = localUserSchema
  .omit({ password: true })
  .extend({ reason: accountReasonSchema });
export type AccountLifecycleInput = z.infer<typeof accountLifecycleInputSchema>;
export type TemporaryAccountInput = z.infer<typeof temporaryAccountInputSchema>;
export const ACCOUNT_LIFECYCLE_LABELS = {
  deactivate: "Deactivate account",
  reactivate: "Reactivate account",
  remove: "Remove account",
} as const;
