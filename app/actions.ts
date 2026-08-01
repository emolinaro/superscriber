"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { TranscriptSegment, USER_ROLES, UserRole } from "@/domain/models";
import { type BootstrapFormState } from "@/lib/auth-forms";
import {
  approveRecordingRevision,
  reopenRecordingRevision,
  saveRecordingDraft,
  submitRecording,
} from "@/server/repository";
import {
  assignRecordingToUser,
  canAccessRecording,
  removeRecordingAssignment,
} from "@/server/access/service";
import {
  createBootstrapAdmin as createBootstrapAdminAccount,
  createLocalUser,
  hasAnyUsers,
} from "@/server/auth/service";
import { bootstrapAdminSchema, localUserSchema } from "@/server/auth/validation";
import { requireActivePrincipal } from "@/server/session";

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

function rethrowIfRedirect(error: unknown) {
  if (isRedirectError(error)) {
    throw error;
  }
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

function assertAdminRole(role: UserRole) {
  if (role !== "admin") {
    throw new Error("Only admin accounts can manage users and assignments.");
  }
}

function assertAssignedRecordingAccess(principal: Awaited<ReturnType<typeof requireActivePrincipal>>, recordingId: string) {
  const access = canAccessRecording(principal, recordingId);
  if (!access.allowed) {
    throw new Error(access.reason ?? "This recording is not assigned to your account.");
  }
}

function requireFormValue(formData: FormData, key: string, message: string) {
  const value = asString(formData, key).trim();
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function parseRole(formData: FormData) {
  const role = asString(formData, "role");
  return USER_ROLES.includes(role as UserRole) ? (role as UserRole) : null;
}

function mapBootstrapFieldErrors(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const errors: BootstrapFormState["fieldErrors"] = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (
      key === "displayName" ||
      key === "email" ||
      key === "password" ||
      key === "confirmPassword"
    ) {
      errors[key] = issue.message;
    }
  }

  return errors;
}

export async function createBootstrapAdminAction(
  _previousState: BootstrapFormState,
  formData: FormData,
): Promise<BootstrapFormState> {
  const values = {
    displayName: asString(formData, "displayName"),
    email: asString(formData, "email"),
  };

  if (await hasAnyUsers()) {
    return {
      formError: "First-run setup is already complete. Sign in with an existing account.",
      values,
    };
  }

  const parsed = bootstrapAdminSchema.safeParse({
    displayName: values.displayName,
    email: values.email,
    password: asString(formData, "password"),
    confirmPassword: asString(formData, "confirmPassword"),
  });

  if (!parsed.success) {
    return {
      formError: "Review the highlighted fields and try again.",
      fieldErrors: mapBootstrapFieldErrors(parsed.error.issues),
      values,
    };
  }

  try {
    await createBootstrapAdminAccount({
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      password: parsed.data.password,
    });
  } catch (error) {
    return {
      formError:
        error instanceof Error
          ? error.message
          : "The first administrator account could not be created.",
      values,
    };
  }

  redirectWithMessage("/", {
    notice: "bootstrap-complete",
  });
}

export async function createUserAction(formData: FormData) {
  const principal = await requireActivePrincipal();

  try {
    assertAdminRole(principal.role);
    const role = parseRole(formData);
    if (!role) {
      throw new Error("Choose a valid role for the new account.");
    }

    const parsed = localUserSchema.parse({
      displayName: asString(formData, "displayName"),
      email: asString(formData, "email"),
      password: asString(formData, "password"),
      role,
    });

    await createLocalUser(parsed);
    revalidatePath("/workspace");
    redirectWithMessage("/workspace", {
      notice: `${parsed.displayName} can now sign in as ${parsed.role}.`,
    });
  } catch (error) {
    rethrowIfRedirect(error);
    redirectWithMessage("/workspace", {
      error:
        error instanceof Error ? error.message : "The local account could not be created.",
    });
  }
}

export async function assignRecordingAction(formData: FormData) {
  const principal = await requireActivePrincipal();

  try {
    assertAdminRole(principal.role);
    const recordingId = asString(formData, "recordingId");
    const userId = asString(formData, "userId");
    if (!recordingId || !userId) {
      throw new Error("Choose both a recording and an assigned user.");
    }

    assignRecordingToUser({
      recordingId,
      userId,
      assignedBy: principal,
    });

    revalidatePath("/workspace");
    redirectWithMessage("/workspace", {
      notice: "Recording assignment updated.",
    });
  } catch (error) {
    rethrowIfRedirect(error);
    redirectWithMessage("/workspace", {
      error:
        error instanceof Error
          ? error.message
          : "The recording assignment could not be updated.",
    });
  }
}

export async function unassignRecordingAction(formData: FormData) {
  const principal = await requireActivePrincipal();

  try {
    assertAdminRole(principal.role);
    const assignmentId = asString(formData, "assignmentId");
    if (!assignmentId) {
      throw new Error("Choose an assignment to remove.");
    }

    removeRecordingAssignment({
      assignmentId,
      removedBy: principal,
    });

    revalidatePath("/workspace");
    redirectWithMessage("/workspace", {
      notice: "Recording assignment removed.",
    });
  } catch (error) {
    rethrowIfRedirect(error);
    redirectWithMessage("/workspace", {
      error:
        error instanceof Error
          ? error.message
          : "The recording assignment could not be removed.",
    });
  }
}

export async function saveDraftAction(formData: FormData) {
  const principal = await requireActivePrincipal();
  const role = principal.role;
  const recordingId = asString(formData, "recordingId");

  try {
    const currentRevisionId = requireFormValue(
      formData,
      "currentRevisionId",
      "No draft revision is loaded. Reload this recording and try again.",
    );
    assertAssignedRecordingAccess(principal, recordingId);
    saveRecordingDraft({
      recordingId,
      role,
      expectedCurrentRevisionId: currentRevisionId,
      segments: parseSegmentsJson(formData),
      summary: asString(formData, "summary", "Updated transcript draft."),
    });

    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Draft revision saved server-side.",
    });
  } catch (error) {
    rethrowIfRedirect(error);
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error ? error.message : "The draft could not be saved.",
    });
  }
}

export async function submitRevisionAction(formData: FormData) {
  const principal = await requireActivePrincipal();
  const role = principal.role;
  const recordingId = asString(formData, "recordingId");

  try {
    const loadedRevisionId = requireFormValue(
      formData,
      "currentRevisionId",
      "No draft revision is loaded. Reload this recording and try again.",
    );
    assertAssignedRecordingAccess(principal, recordingId);
    const segments = parseSegmentsJson(formData);
    let revisionIdToSubmit = loadedRevisionId;
    if (segments.length > 0) {
      const savedRevision = saveRecordingDraft({
        recordingId,
        role,
        expectedCurrentRevisionId: loadedRevisionId,
        segments,
        summary: asString(formData, "summary", "Updated transcript draft."),
      });
      revisionIdToSubmit = savedRevision.id;
    }

    submitRecording({
      recordingId,
      role,
      expectedCurrentRevisionId: revisionIdToSubmit,
    });
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Revision submitted for approval.",
    });
  } catch (error) {
    rethrowIfRedirect(error);
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error
          ? error.message
          : "The revision could not be submitted.",
    });
  }
}

export async function approveRevisionAction(formData: FormData) {
  const principal = await requireActivePrincipal();
  const role = principal.role;
  const recordingId = asString(formData, "recordingId");

  try {
    const pendingRevisionId = requireFormValue(
      formData,
      "pendingRevisionId",
      "No pending revision is loaded. Reload this recording and try again.",
    );
    assertAssignedRecordingAccess(principal, recordingId);
    approveRecordingRevision({
      recordingId,
      role,
      expectedPendingRevisionId: pendingRevisionId,
    });
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Transcript approved and locked under policy.",
    });
  } catch (error) {
    rethrowIfRedirect(error);
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error
          ? error.message
          : "The transcript could not be approved.",
    });
  }
}

export async function reopenRevisionAction(formData: FormData) {
  const principal = await requireActivePrincipal();
  const role = principal.role;
  const recordingId = asString(formData, "recordingId");

  try {
    const approvedRevisionId = requireFormValue(
      formData,
      "approvedRevisionId",
      "No approved revision is loaded. Reload this recording and try again.",
    );
    assertAssignedRecordingAccess(principal, recordingId);
    reopenRecordingRevision({
      recordingId,
      role,
      expectedApprovedRevisionId: approvedRevisionId,
    });
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${recordingId}`);
    redirectWithMessage(`/recordings/${recordingId}`, {
      notice: "Approved transcript reopened as a new draft cycle.",
    });
  } catch (error) {
    rethrowIfRedirect(error);
    redirectWithMessage(`/recordings/${recordingId}`, {
      error:
        error instanceof Error
          ? error.message
          : "The transcript could not be reopened.",
    });
  }
}
