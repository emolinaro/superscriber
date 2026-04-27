"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { TranscriptSegment, USER_ROLES, UserRole } from "@/domain/models";
import {
  approveRecordingRevision,
  createRecordingFromFile,
  reopenRecordingRevision,
  saveRecordingDraft,
  submitRecording,
} from "@/server/repository";
import { dispatchRecordingToConfiguredEngine } from "@/server/orchestration/dispatch";
import {
  clearActiveRole,
  requireActiveRole,
  setActiveRole,
} from "@/server/session";

function asString(
  formData: FormData,
  key: string,
  fallback = "",
) {
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

function redirectWithMessage(
  pathname: string,
  messages: Partial<Record<"notice" | "error", string>>,
): never {
  redirect(buildPath(pathname, messages));
}

function parseRole(formData: FormData) {
  const role = asString(formData, "role");
  return USER_ROLES.includes(role as UserRole) ? (role as UserRole) : null;
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
        typeof candidate.confidence === "number" &&
        Number.isFinite(candidate.confidence)
          ? candidate.confidence
          : 0.8,
    } satisfies TranscriptSegment;
  });
}

function assertCanIngest(role: UserRole) {
  if (role !== "uploader" && role !== "admin") {
    throw new Error("Only uploader and admin roles can create new recordings.");
  }
}

export async function enterWorkspaceAction(formData: FormData) {
  const role = parseRole(formData);
  if (!role) {
    redirectWithMessage("/", { error: "Choose a valid role to enter the workspace." });
  }

  await setActiveRole(role);
  redirect("/workspace");
}

export async function switchRoleAction(formData: FormData) {
  const role = parseRole(formData);
  if (!role) {
    redirectWithMessage("/workspace", {
      error: "The requested role is not valid for this demo session.",
    });
  }

  await setActiveRole(role);
  redirect("/workspace");
}

export async function logoutAction() {
  await clearActiveRole();
  redirect("/");
}

export async function ingestRecordingAction(formData: FormData) {
  const role = await requireActiveRole();

  try {
    assertCanIngest(role);

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new Error("Attach or record an audio or video file first.");
    }

    const source = asString(formData, "source", "upload");
    const recording = await createRecordingFromFile({
      file,
      role,
      title: asString(formData, "title", file.name || "Untitled recording"),
      languageHint: asString(formData, "languageHint", "english"),
      source: source === "record" ? "record" : "upload",
    });

    let notice =
      source === "record"
        ? "Recording received and queued for governed verification."
        : "Upload received and queued for governed verification.";

    try {
      const dispatchResult = await dispatchRecordingToConfiguredEngine(recording.id);
      if (dispatchResult.mode === "webhook" && dispatchResult.dispatched) {
        notice = `${notice} External engine dispatch succeeded.`;
      }
    } catch (error) {
      revalidatePath("/workspace");
      revalidatePath(`/recordings/${recording.id}`);
      redirectWithMessage(`/recordings/${recording.id}`, {
        error:
          error instanceof Error
            ? `Recording stored, but backend dispatch failed: ${error.message}`
            : "Recording stored, but backend dispatch failed.",
      });
    }

    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recording.id}`);
    redirectWithMessage(`/recordings/${recording.id}`, {
      notice,
    });
  } catch (error) {
    redirectWithMessage("/workspace", {
      error:
        error instanceof Error
          ? error.message
          : "The recording could not be ingested.",
    });
  }
}

export async function saveDraftAction(formData: FormData) {
  const role = await requireActiveRole();
  const recordingId = asString(formData, "recordingId");

  try {
    saveRecordingDraft({
      recordingId,
      role,
      segments: parseSegmentsJson(formData),
      summary: asString(formData, "summary", "Updated transcript draft."),
    });

    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Draft revision saved server-side.",
    });
  } catch (error) {
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error ? error.message : "The draft could not be saved.",
    });
  }
}

export async function submitRevisionAction(formData: FormData) {
  const role = await requireActiveRole();
  const recordingId = asString(formData, "recordingId");

  try {
    const segments = parseSegmentsJson(formData);
    if (segments.length > 0) {
      saveRecordingDraft({
        recordingId,
        role,
        segments,
        summary: asString(formData, "summary", "Updated transcript draft."),
      });
    }

    submitRecording({ recordingId, role });
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Revision submitted for approval.",
    });
  } catch (error) {
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error
          ? error.message
          : "The revision could not be submitted.",
    });
  }
}

export async function approveRevisionAction(formData: FormData) {
  const role = await requireActiveRole();
  const recordingId = asString(formData, "recordingId");

  try {
    approveRecordingRevision({ recordingId, role });
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Transcript approved and locked under policy.",
    });
  } catch (error) {
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error
          ? error.message
          : "The transcript could not be approved.",
    });
  }
}

export async function reopenRevisionAction(formData: FormData) {
  const role = await requireActiveRole();
  const recordingId = asString(formData, "recordingId");

  try {
    reopenRecordingRevision({ recordingId, role });
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Approved transcript reopened as a new draft cycle.",
    });
  } catch (error) {
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error
          ? error.message
          : "The transcript could not be reopened.",
    });
  }
}
