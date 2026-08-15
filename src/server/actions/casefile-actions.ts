"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type Principal, type TranscriptSegmentEdit } from "@/domain/models";
import { type CommandResult, type FocusTarget } from "@/lib/command-result";
import { authExpiredResult, toCommandResultError } from "@/lib/command-result";
import { appendQueryMessages } from "@/lib/navigation-path";
import { describeSpeakerRename } from "@/domain/speakers";
import {
  approveRevisionCommand,
  renameSpeakerCommand,
  requestChangesCommand,
  reopenRevisionCommand,
  saveDraftCommand,
  submitRevisionCommand,
  withdrawRevisionCommand,
  type ApproveRevisionCommandInput,
  type RenameSpeakerCommandInput,
  type ReopenRevisionCommandInput,
  type RequestChangesCommandInput,
  type SaveDraftCommandInput,
  type SubmitRevisionCommandInput,
  type WithdrawRevisionCommandInput,
} from "@/server/casefile/commands";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getCasefile, type CasefileViewModel } from "@/server/casefile/read-model";
import { getActivePrincipal } from "@/server/session";

export type CasefileMutationResult = {
  casefile: CasefileViewModel | null;
  nextPath: string;
  focusTarget: FocusTarget;
};

type CasefileMutationSuccess = CasefileMutationResult & {
  notice?: string;
};

function asString(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  return typeof value === "string" ? value : fallback;
}

// Patch protocol parse: only reviewer-owned fields (text, speakerLabel)
// survive; identity, timing, and worker-owned metadata are not readable from
// the wire shape, so a forged payload cannot set them.
function parseEditsJson(formData: FormData) {
  const raw = asString(formData, "editsJson");
  if (!raw) {
    return [] satisfies TranscriptSegmentEdit[];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Transcript edit payload must be an array.");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Transcript edit ${index + 1} is invalid.`);
    }

    const candidate = item as Partial<TranscriptSegmentEdit>;
    if (typeof candidate.id !== "string" || !candidate.id) {
      throw new Error(`Transcript edit ${index + 1} is missing its segment id.`);
    }

    return {
      id: candidate.id,
      ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
      ...(typeof candidate.speakerLabel === "string"
        ? { speakerLabel: candidate.speakerLabel }
        : {}),
    } satisfies TranscriptSegmentEdit;
  });
}

async function refreshCasefileMutation(
  principal: Principal,
  recordingId: string,
  focusTarget: FocusTarget,
  options: { allowAccessLoss?: boolean; actionModeId?: string | null } = {},
): Promise<CasefileMutationSuccess> {
  revalidatePath("/workspace");

  try {
    const casefile = getCasefile(principal, recordingId, {
      actionModeId: options.actionModeId ?? null,
    });
    revalidatePath(`/recordings/${recordingId}`);
    return {
      casefile,
      nextPath: `/recordings/${recordingId}`,
      focusTarget,
    };
  } catch (error) {
    if (
      options.allowAccessLoss &&
      error instanceof CasefileCommandError &&
      error.code === "ACCESS_DENIED"
    ) {
      return {
        casefile: null,
        nextPath: "/workspace",
        focusTarget,
        notice: "Casefile reopened. An administrator must assign the new review cycle.",
      };
    }

    throw error;
  }
}

async function runCasefileAction<T>(
  operation: (principal: Principal) => T,
  success: (value: T, principal: Principal) => Promise<CasefileMutationSuccess>,
  notice: (value: T) => string,
): Promise<CommandResult<CasefileMutationResult>> {
  const principal = await getActivePrincipal();
  if (!principal) {
    return authExpiredResult();
  }

  try {
    const value = operation(principal);
    const mutation = await success(value, principal);
    const { notice: derivedNotice, ...data } = mutation;
    return {
      ok: true,
      data,
      notice: derivedNotice ?? notice(value),
    };
  } catch (error) {
    return toCommandResultError(error);
  }
}

function redirectFromCommandResult(
  result: CommandResult<CasefileMutationResult>,
  fallbackPath: string,
): never {
  if (!result.ok) {
    if (result.code === "AUTH_EXPIRED") {
      redirect("/?reason=session-expired");
    }

    redirect(appendQueryMessages(fallbackPath, { error: result.message }));
  }

  redirect(appendQueryMessages(result.data.nextPath || fallbackPath, { notice: result.notice }));
}

export async function saveDraftAction(
  input: SaveDraftCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => saveDraftCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "retain", {
        actionModeId: input.actionModeId ?? null,
      }),
    () => "Draft revision saved server-side.",
  );
}

export async function submitRevisionAction(
  input: SubmitRevisionCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => submitRevisionCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state", {
        actionModeId: input.actionModeId ?? null,
      }),
    () => "Revision submitted for approval.",
  );
}

export async function renameSpeakerAction(
  input: RenameSpeakerCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => renameSpeakerCommand(principal, input),
    async (_result, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "retain", {
        actionModeId: input.actionModeId ?? null,
      }),
    (result) => describeSpeakerRename(result.rename),
  );
}

export async function withdrawRevisionAction(
  input: WithdrawRevisionCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => withdrawRevisionCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state", {
        actionModeId: input.actionModeId ?? null,
      }),
    () => "Revision withdrawn back to draft.",
  );
}

export async function requestChangesAction(
  input: RequestChangesCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => requestChangesCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state", {
        actionModeId: input.actionModeId ?? null,
      }),
    () => "Changes requested before approval.",
  );
}

export async function approveRevisionAction(
  input: ApproveRevisionCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => approveRevisionCommand(principal, input),
    async (_result, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state", {
        actionModeId: input.actionModeId ?? null,
      }),
    () => "Transcript approved and locked under policy.",
  );
}

export async function reopenRevisionAction(
  input: ReopenRevisionCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => reopenRevisionCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state", {
        allowAccessLoss: true,
        actionModeId: input.actionModeId ?? null,
      }),
    () => "Approved transcript reopened as a new draft cycle.",
  );
}

export async function saveDraftFormAction(formData: FormData) {
  const recordingId = asString(formData, "recordingId");
  return redirectFromCommandResult(
    await saveDraftAction({
      recordingId,
      expectedCurrentRevisionId: asString(formData, "currentRevisionId"),
      edits: parseEditsJson(formData),
      summary: asString(formData, "summary", "Updated transcript draft."),
      actionModeId: asString(formData, "actionModeId") || null,
    }),
    `/recordings/${recordingId}`,
  );
}

export async function submitRevisionFormAction(formData: FormData) {
  const recordingId = asString(formData, "recordingId");
  const edits = parseEditsJson(formData);
  return redirectFromCommandResult(
    await submitRevisionAction({
      recordingId,
      expectedCurrentRevisionId: asString(formData, "currentRevisionId"),
      edits,
      summary: asString(formData, "summary", "Updated transcript draft."),
      hasUnsavedChanges: asString(formData, "hasUnsavedChanges")
        ? asString(formData, "hasUnsavedChanges") === "true"
        : edits.length > 0,
      actionModeId: asString(formData, "actionModeId") || null,
    }),
    `/recordings/${recordingId}`,
  );
}

export async function withdrawRevisionFormAction(formData: FormData) {
  const recordingId = asString(formData, "recordingId");
  return redirectFromCommandResult(
    await withdrawRevisionAction({
      recordingId,
      expectedPendingRevisionId: asString(formData, "pendingRevisionId"),
      reason: asString(formData, "reason"),
      actionModeId: asString(formData, "actionModeId") || null,
    }),
    `/recordings/${recordingId}`,
  );
}

export async function requestChangesFormAction(formData: FormData) {
  const recordingId = asString(formData, "recordingId");
  return redirectFromCommandResult(
    await requestChangesAction({
      recordingId,
      expectedPendingRevisionId: asString(formData, "pendingRevisionId"),
      reason: asString(formData, "reason"),
      actionModeId: asString(formData, "actionModeId") || null,
    }),
    `/recordings/${recordingId}`,
  );
}

export async function approveRevisionFormAction(formData: FormData) {
  const recordingId = asString(formData, "recordingId");
  return redirectFromCommandResult(
    await approveRevisionAction({
      recordingId,
      expectedPendingRevisionId: asString(formData, "pendingRevisionId"),
      note: asString(formData, "note"),
      actionModeId: asString(formData, "actionModeId") || null,
    }),
    `/recordings/${recordingId}`,
  );
}

export async function reopenRevisionFormAction(formData: FormData) {
  const recordingId = asString(formData, "recordingId");
  return redirectFromCommandResult(
    await reopenRevisionAction({
      recordingId,
      expectedApprovedRevisionId: asString(formData, "approvedRevisionId"),
      reason: asString(formData, "reason"),
      actionModeId: asString(formData, "actionModeId") || null,
    }),
    `/recordings/${recordingId}`,
  );
}
