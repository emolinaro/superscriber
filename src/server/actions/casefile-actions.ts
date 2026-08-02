"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type Principal, type TranscriptSegment } from "@/domain/models";
import { type CommandResult, type FocusTarget } from "@/lib/command-result";
import { authExpiredResult, toCommandResultError } from "@/lib/command-result";
import {
  approveRevisionCommand,
  requestChangesCommand,
  reopenRevisionCommand,
  saveDraftCommand,
  submitRevisionCommand,
  withdrawRevisionCommand,
  type ApproveRevisionCommandInput,
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

function parseSegmentsJson(formData: FormData) {
  const raw = asString(formData, "segmentsJson");
  if (!raw) {
    return [] satisfies TranscriptSegment[];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Transcript payload must be an array.");
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Transcript segment ${index + 1} is invalid.`);
    }

    const candidate = item as Partial<TranscriptSegment>;
    return {
      id: typeof candidate.id === "string" ? candidate.id : `segment-${index}`,
      speakerLabel:
        typeof candidate.speakerLabel === "string" && candidate.speakerLabel.trim()
          ? candidate.speakerLabel.trim()
          : `Speaker ${index + 1}`,
      startMs:
        typeof candidate.startMs === "number" && Number.isFinite(candidate.startMs)
          ? candidate.startMs
          : 0,
      endMs:
        typeof candidate.endMs === "number" && Number.isFinite(candidate.endMs)
          ? candidate.endMs
          : 0,
      text: typeof candidate.text === "string" ? candidate.text : "",
      confidence:
        typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)
          ? candidate.confidence
          : 0.8,
    } satisfies TranscriptSegment;
  });
}

async function refreshCasefileMutation(
  principal: Principal,
  recordingId: string,
  focusTarget: FocusTarget,
  options: { allowAccessLoss?: boolean } = {},
): Promise<CasefileMutationResult> {
  revalidatePath("/workspace");
  revalidatePath(`/recordings/${recordingId}`);

  try {
    const casefile = getCasefile(principal, recordingId);
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
      };
    }

    throw error;
  }
}

async function runCasefileAction<T>(
  operation: (principal: Principal) => T,
  success: (value: T, principal: Principal) => Promise<CasefileMutationResult>,
  notice: (value: T) => string,
): Promise<CommandResult<CasefileMutationResult>> {
  const principal = await getActivePrincipal();
  if (!principal) {
    return authExpiredResult();
  }

  try {
    const value = operation(principal);
    return {
      ok: true,
      data: await success(value, principal),
      notice: notice(value),
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

    redirect(buildPath(fallbackPath, { error: result.message }));
  }

  redirect(buildPath(result.data.nextPath || fallbackPath, { notice: result.notice }));
}

export async function saveDraftAction(
  input: SaveDraftCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => saveDraftCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "retain"),
    () => "Draft revision saved server-side.",
  );
}

export async function submitRevisionAction(
  input: SubmitRevisionCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => submitRevisionCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state"),
    () => "Revision submitted for approval.",
  );
}

export async function withdrawRevisionAction(
  input: WithdrawRevisionCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => withdrawRevisionCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state"),
    () => "Revision withdrawn back to draft.",
  );
}

export async function requestChangesAction(
  input: RequestChangesCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => requestChangesCommand(principal, input),
    async (_revision, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state"),
    () => "Changes requested before approval.",
  );
}

export async function approveRevisionAction(
  input: ApproveRevisionCommandInput,
): Promise<CommandResult<CasefileMutationResult>> {
  return runCasefileAction(
    (principal) => approveRevisionCommand(principal, input),
    async (_result, principal) =>
      refreshCasefileMutation(principal, input.recordingId, "case-state"),
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
      segments: parseSegmentsJson(formData),
      summary: asString(formData, "summary", "Updated transcript draft."),
      actionModeId: asString(formData, "actionModeId") || null,
    }),
    `/recordings/${recordingId}`,
  );
}

export async function submitRevisionFormAction(formData: FormData) {
  const recordingId = asString(formData, "recordingId");
  const segments = parseSegmentsJson(formData);
  return redirectFromCommandResult(
    await submitRevisionAction({
      recordingId,
      expectedCurrentRevisionId: asString(formData, "currentRevisionId"),
      segments,
      summary: asString(formData, "summary", "Updated transcript draft."),
      hasUnsavedChanges: asString(formData, "hasUnsavedChanges")
        ? asString(formData, "hasUnsavedChanges") === "true"
        : segments.length > 0,
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
