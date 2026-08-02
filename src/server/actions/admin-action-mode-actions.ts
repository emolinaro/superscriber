"use server";

import { type CommandResult } from "@/lib/command-result";
import { authExpiredResult, toCommandResultError } from "@/lib/command-result";
import {
  enterActionMode,
  exitActionMode,
  type EnterActionModeInput,
  type ExitActionModeInput,
} from "@/server/casefile/action-mode";
import { getActivePrincipal } from "@/server/session";

export type EnterAdminActionModeResult = {
  session: Awaited<ReturnType<typeof enterActionMode>>;
  href: string;
};

export type ExitAdminActionModeResult = {
  href: string;
};

export async function enterAdminActionModeAction(
  input: Omit<EnterActionModeInput, "principal">,
): Promise<CommandResult<EnterAdminActionModeResult>> {
  const principal = await getActivePrincipal();
  if (!principal) {
    return authExpiredResult();
  }

  try {
    const session = enterActionMode({
      principal,
      ...input,
    });

    return {
      ok: true,
      data: {
        session,
        href: `/recordings/${input.recordingId}?actionMode=${session.id}`,
      },
      notice: `Admin action mode entered as ${session.effectiveRole}.`,
    };
  } catch (error) {
    return toCommandResultError(error);
  }
}

export async function exitAdminActionModeAction(
  input: Omit<ExitActionModeInput, "principal">,
): Promise<CommandResult<ExitAdminActionModeResult>> {
  const principal = await getActivePrincipal();
  if (!principal) {
    return authExpiredResult();
  }

  try {
    exitActionMode({
      principal,
      ...input,
    });

    return {
      ok: true,
      data: {
        href: `/recordings/${input.recordingId}`,
      },
      notice: "Admin action mode exited.",
    };
  } catch (error) {
    return toCommandResultError(error);
  }
}
