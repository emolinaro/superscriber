import { z } from "zod";
import { USER_ROLES, type UserRole } from "@/domain/models";

export const CHANGE_REASON_MIN = 10;
export const CHANGE_REASON_MAX = 500;

export const changeAccountRoleInputSchema = z
  .object({
    userId: z.string().trim().min(1, "Choose an account."),
    expectedRole: z.enum(USER_ROLES),
    newRole: z.enum(USER_ROLES),
    reason: z
      .string()
      .trim()
      .min(
        CHANGE_REASON_MIN,
        "Enter a change reason between 10 and 500 characters.",
      )
      .max(
        CHANGE_REASON_MAX,
        "Enter a change reason between 10 and 500 characters.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expectedRole === value.newRole) {
      context.addIssue({
        code: "custom",
        path: ["newRole"],
        message: "Choose a role different from the current role.",
      });
    }
  });

export type ChangeAccountRoleInput = z.infer<
  typeof changeAccountRoleInputSchema
>;

export type AccountRoleChangeErrorCode =
  | "AUTH_EXPIRED"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "STATE_CHANGED"
  | "BREAK_GLASS_PROTECTED"
  | "LAST_ACTIVE_ADMIN"
  | "ASSIGNMENTS_INCOMPATIBLE"
  | "INTERNAL_ERROR";

export type AssignmentBlockers = {
  total: number;
  byRole: Array<{
    role: "reviewer" | "approver";
    count: number;
    recordingTitles: string[];
  }>;
  managementHref: string;
};

export type AccountRoleChangeFailure = {
  code: AccountRoleChangeErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
  currentRole?: UserRole;
  assignmentBlockers?: AssignmentBlockers;
  correlationId?: string;
};

export const ACCOUNT_ROLE_CHANGE_COPY = {
  AUTH_EXPIRED: "Session expired. Sign in again to continue.",
  ACCESS_DENIED: "Only active administrator accounts can change account roles.",
  NOT_FOUND: "This account is no longer available. Refresh the account list.",
  VALIDATION_ERROR:
    "Enter a change reason between 10 and 500 characters.",
  STATE_CHANGED:
    "This account's role changed after the list loaded. Review the current role and try again.",
  BREAK_GLASS_PROTECTED:
    "This account is the designated break-glass administrator. Transfer the designation before changing its role.",
  LAST_ACTIVE_ADMIN:
    "At least one active administrator must remain. Promote another active account to Administrator before changing this role.",
  INTERNAL_ERROR:
    "The role change could not be confirmed. Refresh the account list before trying again.",
} as const;

export function assignmentsIncompatibleMessage(newRoleLabel: string) {
  return `Remove the listed active assignments before changing this account to ${newRoleLabel}.`;
}
