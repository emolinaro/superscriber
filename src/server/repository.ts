export { listAdministration } from "@/server/administration/service";
export { getCasefile } from "@/server/casefile/read-model";
export { listWorkInbox } from "@/server/work-inbox/service";

import { basename } from "node:path";
import { statSync, existsSync } from "node:fs";
import {
  AuditEvent,
  IngestionSession,
  Principal,
  Recording,
  TranscriptJob,
  TranscriptRevision,
  UserRole,
  Workspace,
  WorkspaceBucket,
} from "@/domain/models";
import { bucketRecording } from "@/domain/workflow";
import { describePolicyProfile, evaluatePolicy } from "@/domain/policy";
import type { ApprovedTranscriptExportFormat } from "@/lib/approved-transcript-export";
import {
  assignmentMapByRecordingId,
  canAccessRecording,
  visibleRecordingIdsForPrincipal,
  type AssignmentSummary,
} from "@/server/access/service";
import { noteOrchestrationDispatchFailure } from "@/server/orchestration/service";
import { buildApprovedTranscriptExport } from "@/server/transcript-export";
import { readSynchronizedState, withState } from "@/server/store";

function fileSafeName(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function summarizeAudit(events: AuditEvent[], recordingId: string | null) {
  return events.filter((event) => event.recordingId === recordingId).slice(0, 20);
}

export type RecordingDetail = {
  workspace: Workspace;
  recording: Recording;
  ingestionSession: IngestionSession | null;
  transcriptJob: TranscriptJob | null;
  currentRevision: TranscriptRevision | null;
  policySummary: string;
  policyDecision: ReturnType<typeof evaluatePolicy>;
  revisions: TranscriptRevision[];
  auditEvents: AuditEvent[];
};

export type WorkspaceOverview = {
  workspace: Workspace;
  policySummary: string;
  policyDecision: ReturnType<typeof evaluatePolicy>;
  visibleRecordings: Recording[];
  nextAssignedRecording: Recording | null;
  assignmentsByRecordingId: Map<string, AssignmentSummary[]>;
  buckets: Array<{
    bucket: WorkspaceBucket;
    label: string;
    description: string;
    recordings: Recording[];
  }>;
};

const BUCKET_META: Record<
  WorkspaceBucket,
  { label: string; description: string }
> = {
  needs_ingest: {
    label: "Needs ingest attention",
    description: "Capture or upload items still waiting to enter the governed pipeline.",
  },
  verifying: {
    label: "Verifying",
    description: "Recordings are being verified server-side before they reach review.",
  },
  transcribing: {
    label: "Transcribing",
    description: "The canonical orchestration layer is producing transcript and diarization output.",
  },
  needs_review: {
    label: "Needs review",
    description: "Draft transcripts are ready for reviewer correction.",
  },
  pending_approval: {
    label: "Pending approval",
    description: "A reviewer submitted a revision and it now needs an approver decision.",
  },
  approved: {
    label: "Approved records",
    description: "Approved transcripts with policy-gated export rights.",
  },
};

function preferredBucketForRole(role: UserRole) {
  if (role === "reviewer") {
    return "needs_review" satisfies WorkspaceBucket;
  }

  if (role === "approver") {
    return "pending_approval" satisfies WorkspaceBucket;
  }

  return null;
}

function resolveApprovedRevision(
  recording: Recording,
  revisions: TranscriptRevision[],
) {
  return revisions.find((entry) => entry.id === recording.approvedRevisionId) ?? null;
}

function approvedTranscriptExportBaseName(title: string) {
  return fileSafeName(title || "transcript").replace(/\.[^.]+$/, "") || "transcript";
}

export function listWorkspaceOverview(principal: Principal): WorkspaceOverview {
  const state = readSynchronizedState();
  const workspace = state.workspaces[0];
  const policyDecision = evaluatePolicy(workspace.policyProfileId, principal.role);
  const visibleIds = visibleRecordingIdsForPrincipal(principal);
  const visibleRecordings =
    visibleIds === null
      ? state.recordings
      : state.recordings.filter((recording) => visibleIds.has(recording.id));
  const assignmentsByRecordingId = assignmentMapByRecordingId(
    visibleRecordings.map((recording) => recording.id),
  );

  const grouped = visibleRecordings.reduce<Record<WorkspaceBucket, Recording[]>>(
    (accumulator, recording) => {
      const bucket = bucketRecording(recording);
      accumulator[bucket].push(recording);
      return accumulator;
    },
    {
      needs_ingest: [],
      verifying: [],
      transcribing: [],
      needs_review: [],
      pending_approval: [],
      approved: [],
    },
  );

  const preferredBucket = preferredBucketForRole(principal.role);
  const nextAssignedRecording =
    (preferredBucket ? grouped[preferredBucket][0] : null) ??
    visibleRecordings[0] ??
    null;

  return {
    workspace,
    policySummary: describePolicyProfile(workspace.policyProfileId),
    policyDecision,
    visibleRecordings,
    nextAssignedRecording,
    assignmentsByRecordingId,
    buckets: Object.entries(BUCKET_META).map(([bucket, meta]) => ({
      bucket: bucket as WorkspaceBucket,
      label: meta.label,
      description: meta.description,
      recordings: grouped[bucket as WorkspaceBucket],
    })),
  };
}

export function getRecordingDetail(
  recordingId: string,
  role: UserRole,
): RecordingDetail | null {
  const state = readSynchronizedState();
  const recording = state.recordings.find((entry) => entry.id === recordingId);
  if (!recording) {
    return null;
  }

  const workspace = state.workspaces.find(
    (entry) => entry.id === recording.workspaceId,
  );
  if (!workspace) {
    return null;
  }

  const revisions = state.revisions
    .filter((entry) => entry.recordingId === recordingId)
    .sort((left, right) => right.version - left.version);
  const ingestionSession =
    state.ingestionSessions.find(
      (entry) => entry.id === recording.ingestionSessionId,
    ) ?? null;
  const transcriptJob =
    state.transcriptJobs.find((entry) => entry.id === recording.transcriptJobId) ?? null;

  const currentRevision =
    revisions.find((entry) => entry.id === recording.currentRevisionId) ?? null;

  return {
    workspace,
    recording,
    ingestionSession,
    transcriptJob,
    currentRevision,
    policySummary: describePolicyProfile(workspace.policyProfileId),
    policyDecision: evaluatePolicy(workspace.policyProfileId, role),
    revisions,
    auditEvents: summarizeAudit(state.auditEvents, recordingId),
  };
}

export function noteRecordingDispatchFailure(params: {
  recordingId: string;
  detail: string;
}) {
  return withState((state) => {
    noteOrchestrationDispatchFailure(params.recordingId, params.detail, state);
  });
}

export function resolveMedia(recordingId: string, role: UserRole) {
  const detail = getRecordingDetail(recordingId, role);
  if (!detail) {
    return null;
  }

  if (!detail.policyDecision.canViewMedia) {
    return {
      denied: true as const,
      reason: "This role cannot stream raw media in the current policy profile.",
    };
  }

  if (!detail.recording.mediaPath || !existsSync(detail.recording.mediaPath)) {
    return {
      denied: false as const,
      missing: true as const,
    };
  }

  const stats = statSync(detail.recording.mediaPath);

  return {
    denied: false as const,
    missing: false as const,
    path: detail.recording.mediaPath,
    size: stats.size,
    mimeType: detail.recording.mimeType ?? "application/octet-stream",
  };
}

export function resolveMediaForPrincipal(recordingId: string, principal: Principal) {
  const access = canAccessRecording(principal, recordingId);
  if (!access.allowed) {
    return {
      denied: true as const,
      reason: access.reason,
    };
  }

  return resolveMedia(recordingId, principal.role);
}

export async function resolveApprovedTranscriptExport(
  recordingId: string,
  role: UserRole,
  format: ApprovedTranscriptExportFormat = "txt",
) {
  const detail = getRecordingDetail(recordingId, role);
  if (!detail) {
    return null;
  }

  if (!detail.policyDecision.canDownloadApprovedTranscript) {
    return {
      denied: true as const,
      reason: "This role cannot export approved transcripts in the current policy profile.",
    };
  }

  const approvedRevision = resolveApprovedRevision(detail.recording, detail.revisions);
  if (!approvedRevision) {
    return {
      denied: false as const,
      missing: true as const,
    };
  }

  const payload = await buildApprovedTranscriptExport({
    format,
    recording: detail.recording,
    revision: approvedRevision,
  });
  const safeBase = approvedTranscriptExportBaseName(detail.recording.title);

  return {
    denied: false as const,
    missing: false as const,
    fileName: `${safeBase}-approved-v${approvedRevision.version}.${format}`,
    contentType: payload.contentType,
    body: payload.body,
  };
}

export async function resolveApprovedTranscriptExportForPrincipal(
  recordingId: string,
  principal: Principal,
  format?: ApprovedTranscriptExportFormat,
) {
  const access = canAccessRecording(principal, recordingId);
  if (!access.allowed) {
    return {
      denied: true as const,
      reason: access.reason,
    };
  }

  return resolveApprovedTranscriptExport(
    recordingId,
    principal.role === "admin" ? "approver" : principal.role,
    format,
  );
}
