"use server";
import {
  authExpiredResult,
  toCommandResultError,
  type CommandResult,
} from "@/lib/command-result";
import { deactivateOwnAccount } from "@/server/auth/account-lifecycle";
import { getActiveSession } from "@/server/session";

export async function deactivateOwnAccountAction(input: {
  expectedActorUserId: string;
  reason: string;
}): Promise<CommandResult<{ userId: string }>> {
  const session = await getActiveSession();
  if (!session) return authExpiredResult();
  if (session.user.userId !== input.expectedActorUserId)
    return {
      ok: false,
      code: "ACCESS_DENIED",
      message: "The signed-in account changed. Reload this page.",
    };
  try {
    return {
      ok: true,
      data: deactivateOwnAccount({
        actorUserId: session.user.userId,
        actorAuthSessionId: session.authSessionId,
        reason: input.reason,
      }),
    };
  } catch (error) {
    return toCommandResultError(error);
  }
}
