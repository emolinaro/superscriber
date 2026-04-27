import { basename, extname, join } from "node:path";
import { mkdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import {
  AuditEvent,
  IngestionSession,
  Recording,
  TranscriptJob,
  TranscriptRevision,
  UserRole,
  Workspace,
  WorkspaceBucket,
} from "@/domain/models";
import { bucketRecording, createRecordingEntry, saveDraftRevision, submitRevision, approveRevision, reopenApprovedRevision } from "@/domain/workflow";
import { describePolicyProfile, evaluatePolicy } from "@/domain/policy";
import { getConfiguredAdapterId } from "@/server/orchestration/config";
import { noteOrchestrationDispatchFailure } from "@/server/orchestration/service";
import { MEDIA_DIR, readState, withState } from "@/server/store";

function mediaKindForMime(mimeType: string | null): Recording["mediaKind"] {
  return mimeType?.startsWith("video/") ? "video" : "audio";
}

function fileSafeName(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function summarizeAudit(events: AuditEvent[], recordingId: string | null) {
  return events.filter((event) => event.recordingId === recordingId).slice(0, 20);
}

function formatTranscriptExport(recording: Recording, revision: TranscriptRevision) {
  const header = [
    `Title: ${recording.title}`,
    `Revision: ${revision.version}`,
    `Language: ${recording.languageHint}`,
    `Source: ${recording.source}`,
    "",
  ];

  const body = revision.segments.map((segment) => {
    const start = Math.floor(segment.startMs / 1000);
    const end = Math.floor(segment.endMs / 1000);
    return `[${start}s-${end}s] ${segment.speakerLabel}: ${segment.text}`;
  });

  return [...header, ...body].join("\n");
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

export function listWorkspaceOverview(role: UserRole): WorkspaceOverview {
  const state = readState();
  const workspace = state.workspaces[0];
  const policyDecision = evaluatePolicy(workspace.policyProfileId, role);

  const grouped = state.recordings.reduce<Record<WorkspaceBucket, Recording[]>>(
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

  return {
    workspace,
    policySummary: describePolicyProfile(workspace.policyProfileId),
    policyDecision,
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
  const state = readState();
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

export async function createRecordingFromFile(params: {
  file: File;
  title: string;
  role: UserRole;
  languageHint: string;
  source: Recording["source"];
}) {
  const buffer = Buffer.from(await params.file.arrayBuffer());
  const safeName = `${crypto.randomUUID()}${extname(params.file.name || ".bin")}`;
  mkdirSync(MEDIA_DIR, { recursive: true });
  const mediaPath = join(MEDIA_DIR, safeName);
  writeFileSync(mediaPath, buffer);

  return withState((state) =>
    createRecordingEntry({
      state,
      workspaceId: state.workspaces[0].id,
      title: params.title.trim() || params.file.name || "Untitled recording",
      source: params.source,
      mediaKind: mediaKindForMime(params.file.type || null),
      mimeType: params.file.type || null,
      mediaPath,
      originalFileName: params.file.name ? fileSafeName(params.file.name) : null,
      languageHint: params.languageHint || "english",
      role: params.role,
      adapterId: getConfiguredAdapterId(),
    }),
  );
}

export function noteRecordingDispatchFailure(params: {
  recordingId: string;
  detail: string;
}) {
  return withState((state) => {
    noteOrchestrationDispatchFailure(params.recordingId, params.detail, state);
  });
}

export function saveRecordingDraft(params: {
  recordingId: string;
  role: UserRole;
  segments: TranscriptRevision["segments"];
  summary: string;
}) {
  return withState((state) =>
    saveDraftRevision({
      state,
      recordingId: params.recordingId,
      role: params.role,
      segments: params.segments,
      summary: params.summary,
    }),
  );
}

export function submitRecording(params: { recordingId: string; role: UserRole }) {
  return withState((state) =>
    submitRevision({
      state,
      recordingId: params.recordingId,
      role: params.role,
    }),
  );
}

export function approveRecordingRevision(params: {
  recordingId: string;
  role: UserRole;
}) {
  return withState((state) =>
    approveRevision({
      state,
      recordingId: params.recordingId,
      role: params.role,
    }),
  );
}

export function reopenRecordingRevision(params: {
  recordingId: string;
  role: UserRole;
}) {
  return withState((state) =>
    reopenApprovedRevision({
      state,
      recordingId: params.recordingId,
      role: params.role,
    }),
  );
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

export function resolveApprovedTranscriptExport(
  recordingId: string,
  role: UserRole,
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

  const approvedRevision = detail.revisions.find(
    (entry) => entry.id === detail.recording.approvedRevisionId,
  );
  if (!approvedRevision) {
    return {
      denied: false as const,
      missing: true as const,
    };
  }

  const safeBase = fileSafeName(detail.recording.title || "transcript").replace(
    /\.[^.]+$/,
    "",
  );

  return {
    denied: false as const,
    missing: false as const,
    fileName: `${safeBase || "transcript"}-approved-v${approvedRevision.version}.txt`,
    content: formatTranscriptExport(detail.recording, approvedRevision),
  };
}
