"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type UserRole } from "@/domain/models";
import { type CommandResult } from "@/lib/command-result";
import { authExpiredResult, toCommandResultError } from "@/lib/command-result";
import {
  assignRecordingToUser,
  removeRecordingAssignment,
  type AccountDirectoryEntry,
} from "@/server/access/service";
import { createLocalUser } from "@/server/auth/service";
import { localUserSchema } from "@/server/auth/validation";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getActivePrincipal } from "@/server/session";

export type AdministrationMutationResult = {
  href: string;
  userId?: string;
  user?: AccountDirectoryEntry;
  assignmentId?: string;
  alreadyActive?: boolean;
};

export type CreateUserInput = {
  displayName: string;
  email: string;
  password: string;
  role: UserRole;
};

export type AssignRecordingInput = {
  recordingId: string;
  userId: string;
};

export type RemoveRecordingAssignmentInput = {
  assignmentId: string;
};

export type UnassignRecordingInput = RemoveRecordingAssignmentInput;

function asString(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  return typeof value === "string" ? value : fallback;
}

function buildPath(
  pathname: string,
  messages: Partial<Record<"notice" | "error", string>>,
) {
  const search = new URLSearchParams();
  if (messages.notice) {
    search.set("notice", messages.notice);
  }
  if (messages.error) {
    search.set("error", messages.error);
  }

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function requireAdmin(role: UserRole) {
  if (role !== "admin") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Only admin accounts can manage users and assignments.",
    );
  }
}

async function runAdministrationAction<T>(
  operation: (principal: NonNullable<Awaited<ReturnType<typeof getActivePrincipal>>>) => Promise<T> | T,
  success: (value: T) => AdministrationMutationResult,
  notice: (value: T) => string,
): Promise<CommandResult<AdministrationMutationResult>> {
  const principal = await getActivePrincipal();
  if (!principal) {
    return authExpiredResult();
  }

  try {
    const value = await operation(principal);
    revalidatePath("/administration");
    revalidatePath("/workspace");
    return {
      ok: true,
      data: success(value),
      notice: notice(value),
    };
  } catch (error) {
    return toCommandResultError(error);
  }
}

function redirectFromCommandResult(
  result: CommandResult<AdministrationMutationResult>,
): never {
  if (!result.ok) {
    if (result.code === "AUTH_EXPIRED") {
      redirect("/?reason=session-expired");
    }

    redirect(buildPath("/administration", { error: result.message }));
  }

  redirect(buildPath(result.data.href, { notice: result.notice }));
}

export async function createUserAction(
  input: CreateUserInput,
): Promise<CommandResult<AdministrationMutationResult>> {
  return runAdministrationAction(
    async (principal) => {
      requireAdmin(principal.role);
      const parsed = localUserSchema.safeParse(input);
      if (!parsed.success) {
        throw new CasefileCommandError(
          "VALIDATION_ERROR",
          "Review the highlighted fields and try again.",
          Object.fromEntries(
            Object.entries(parsed.error.flatten().fieldErrors)
              .filter(([, value]) => typeof value?.[0] === "string")
              .map(([key, value]) => [key, value![0] as string]),
          ),
        );
      }

      return createLocalUser(parsed.data);
    },
    (value) => ({
      href: "/administration?section=accounts",
      userId: value.id,
      user: {
        ...value,
        activeAssignmentCount: 0,
      },
    }),
    (value) => `${value.displayName} can now sign in as ${value.role}.`,
  );
}

export async function assignRecordingAction(
  input: AssignRecordingInput,
): Promise<CommandResult<AdministrationMutationResult>> {
  return runAdministrationAction(
    (principal) => {
      requireAdmin(principal.role);
      if (!input.recordingId.trim() || !input.userId.trim()) {
        throw new CasefileCommandError(
          "VALIDATION_ERROR",
          "Choose both a recording and an assigned user.",
          {
            recordingId: "Choose both a recording and an assigned user.",
            userId: "Choose both a recording and an assigned user.",
          },
        );
      }

      return assignRecordingToUser({
        recordingId: input.recordingId,
        userId: input.userId,
        assignedBy: principal,
      });
    },
    (value) => ({
      href: "/administration?section=assignments",
      assignmentId: value.assignment.id,
      alreadyActive: value.alreadyActive,
    }),
    () => "Recording assignment updated.",
  );
}

export async function removeRecordingAssignmentAction(
  input: RemoveRecordingAssignmentInput,
): Promise<CommandResult<AdministrationMutationResult>> {
  return runAdministrationAction(
    (principal) => {
      requireAdmin(principal.role);
      if (!input.assignmentId.trim()) {
        throw new CasefileCommandError(
          "VALIDATION_ERROR",
          "Choose an assignment to remove.",
          {
            assignmentId: "Choose an assignment to remove.",
          },
        );
      }

      return removeRecordingAssignment({
        assignmentId: input.assignmentId,
        removedBy: principal,
      });
    },
    (value) => ({
      href: "/administration?section=assignments",
      assignmentId: value.id,
    }),
    () => "Recording assignment removed.",
  );
}

export async function unassignRecordingAction(
  input: UnassignRecordingInput,
): Promise<CommandResult<AdministrationMutationResult>> {
  return removeRecordingAssignmentAction(input);
}

export async function createUserFormAction(formData: FormData) {
  return redirectFromCommandResult(
    await createUserAction({
      displayName: asString(formData, "displayName"),
      email: asString(formData, "email"),
      password: asString(formData, "password"),
      role: asString(formData, "role") as UserRole,
    }),
  );
}

export async function assignRecordingFormAction(formData: FormData) {
  return redirectFromCommandResult(
    await assignRecordingAction({
      recordingId: asString(formData, "recordingId"),
      userId: asString(formData, "userId"),
    }),
  );
}

export async function removeRecordingAssignmentFormAction(formData: FormData) {
  return redirectFromCommandResult(
    await removeRecordingAssignmentAction({
      assignmentId: asString(formData, "assignmentId"),
    }),
  );
}

export async function unassignRecordingFormAction(formData: FormData) {
  return removeRecordingAssignmentFormAction(formData);
}
