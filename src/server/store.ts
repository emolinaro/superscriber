import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AppState,
  AuditEvent,
  IngestionSession,
  PolicyProfile,
  Recording,
  TranscriptJob,
  TranscriptRevision,
  Workspace,
} from "@/domain/models";
import { normalizeState, synchronizeOrchestration } from "@/server/orchestration/service";

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, "data");
export const MEDIA_DIR = join(DATA_DIR, "media");
const STATE_FILE = join(DATA_DIR, "state.json");

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function seedState(): AppState {
  const workspace: Workspace = {
    id: "workspace-regulated",
    name: "Regulated Review Workspace",
    slug: "regulated-review-workspace",
    policyProfileId: "strict",
  };

  const policies: PolicyProfile[] = [
    {
      id: "strict",
      label: "Strict regulated mode",
      description:
        "Raw media never downloads. Approved exports stay policy-gated.",
    },
    {
      id: "reviewable-approved-export",
      label: "Approved export mode",
      description:
        "Approved transcripts may be exported by reviewers and approvers. Raw media remains server-bound.",
    },
  ];

  const draftRevision: TranscriptRevision = {
    id: "rev-seed-draft",
    recordingId: "rec-seed-review",
    version: 1,
    state: "draft",
    basedOnRevisionId: null,
    createdByRole: "system",
    createdAt: nowIso(),
    submittedAt: null,
    approvedAt: null,
    summary: "Seeded draft for reviewer handoff.",
    segments: [
      {
        id: "seg-1",
        speakerLabel: "Speaker A",
        startMs: 0,
        endMs: 12_000,
        text: "This seeded transcript is ready for review in the browser.",
        confidence: 0.94,
      },
      {
        id: "seg-2",
        speakerLabel: "Speaker B",
        startMs: 12_000,
        endMs: 24_000,
        text: "No local download is required to edit or approve it.",
        confidence: 0.92,
      },
    ],
  };

  const pendingRevision: TranscriptRevision = {
    id: "rev-seed-pending",
    recordingId: "rec-seed-approval",
    version: 2,
    state: "pending_approval",
    basedOnRevisionId: null,
    createdByRole: "reviewer",
    createdAt: nowIso(),
    submittedAt: nowIso(),
    approvedAt: null,
    summary: "Awaiting approver sign-off.",
    segments: [
      {
        id: "seg-3",
        speakerLabel: "Speaker A",
        startMs: 0,
        endMs: 15_000,
        text: "This item demonstrates the approval queue.",
        confidence: 0.91,
      },
      {
        id: "seg-4",
        speakerLabel: "Speaker B",
        startMs: 15_000,
        endMs: 29_000,
        text: "Approvers can lock the record and govern transcript export.",
        confidence: 0.89,
      },
    ],
  };

  const recordings: Recording[] = [
    {
      id: "rec-seed-review",
      workspaceId: workspace.id,
      title: "Seeded needs-review item",
      source: "upload",
      mediaKind: "audio",
      mimeType: null,
      mediaPath: null,
      originalFileName: null,
      languageHint: "english",
      uploadedByRole: "uploader",
      ingestionSessionId: "ingest-seed-review",
      transcriptJobId: "job-seed-review",
      integrityState: "verified",
      transcriptJobState: "completed",
      currentRevisionId: draftRevision.id,
      approvedRevisionId: null,
      pendingRevisionId: null,
      verificationSummary: "Seed item verified. No source media shipped in local demo.",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      automationCursor: null,
    },
    {
      id: "rec-seed-approval",
      workspaceId: workspace.id,
      title: "Seeded pending-approval item",
      source: "record",
      mediaKind: "audio",
      mimeType: null,
      mediaPath: null,
      originalFileName: null,
      languageHint: "english",
      uploadedByRole: "uploader",
      ingestionSessionId: "ingest-seed-approval",
      transcriptJobId: "job-seed-approval",
      integrityState: "verified",
      transcriptJobState: "completed",
      currentRevisionId: pendingRevision.id,
      approvedRevisionId: null,
      pendingRevisionId: pendingRevision.id,
      verificationSummary: "Seed item verified and awaiting approver decision.",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      automationCursor: null,
    },
    {
      id: "rec-seed-running",
      workspaceId: workspace.id,
      title: "Seeded in-flight transcription",
      source: "upload",
      mediaKind: "audio",
      mimeType: null,
      mediaPath: null,
      originalFileName: null,
      languageHint: "english",
      uploadedByRole: "uploader",
      ingestionSessionId: "ingest-seed-running",
      transcriptJobId: "job-seed-running",
      integrityState: "verified",
      transcriptJobState: "running",
      currentRevisionId: null,
      approvedRevisionId: null,
      pendingRevisionId: null,
      verificationSummary: "Transcription started by the mock adapter.",
      createdAt: nowIso(),
      updatedAt: new Date(Date.now() - 3_000).toISOString(),
      automationCursor: null,
    },
  ];

  const ingestionSessions: IngestionSession[] = [
    {
      id: "ingest-seed-review",
      recordingId: "rec-seed-review",
      source: "upload",
      state: "verified",
      adapter: "mock-governed-engine",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: nowIso(),
      verifiedAt: nowIso(),
      lastError: null,
      verificationSummary: "Seed item verified. No source media shipped in local demo.",
      resumeToken: "resume-seed-review",
      bytesReceived: null,
      bytesExpected: null,
    },
    {
      id: "ingest-seed-approval",
      recordingId: "rec-seed-approval",
      source: "record",
      state: "verified",
      adapter: "mock-governed-engine",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: nowIso(),
      verifiedAt: nowIso(),
      lastError: null,
      verificationSummary: "Seed item verified and awaiting approver decision.",
      resumeToken: "resume-seed-approval",
      bytesReceived: null,
      bytesExpected: null,
    },
    {
      id: "ingest-seed-running",
      recordingId: "rec-seed-running",
      source: "upload",
      state: "verified",
      adapter: "mock-governed-engine",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: nowIso(),
      verifiedAt: nowIso(),
      lastError: null,
      verificationSummary: "Transcription started by the mock adapter.",
      resumeToken: "resume-seed-running",
      bytesReceived: null,
      bytesExpected: null,
    },
  ];

  const transcriptJobs: TranscriptJob[] = [
    {
      id: "job-seed-review",
      recordingId: "rec-seed-review",
      state: "completed",
      adapter: "mock-governed-engine",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: nowIso(),
      completedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      etaSeconds: 0,
      progressPercent: 100,
      outputRevisionId: draftRevision.id,
      lastError: null,
      diarizationStatus: "available",
    },
    {
      id: "job-seed-approval",
      recordingId: "rec-seed-approval",
      state: "completed",
      adapter: "mock-governed-engine",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: nowIso(),
      completedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      etaSeconds: 0,
      progressPercent: 100,
      outputRevisionId: pendingRevision.id,
      lastError: null,
      diarizationStatus: "available",
    },
    {
      id: "job-seed-running",
      recordingId: "rec-seed-running",
      state: "running",
      adapter: "mock-governed-engine",
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      updatedAt: new Date(Date.now() - 3_000).toISOString(),
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      completedAt: null,
      lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
      etaSeconds: 22,
      progressPercent: 62,
      outputRevisionId: null,
      lastError: null,
      diarizationStatus: "pending",
    },
  ];

  const auditEvents: AuditEvent[] = [
    {
      id: createId("audit"),
      workspaceId: workspace.id,
      recordingId: "rec-seed-review",
      actorRole: "system",
      type: "transcription.completed",
      detail: "Seeded review item materialized for browser editing.",
      createdAt: nowIso(),
    },
    {
      id: createId("audit"),
      workspaceId: workspace.id,
      recordingId: "rec-seed-approval",
      actorRole: "reviewer",
      type: "revision.submitted",
      detail: "Seeded approval item submitted.",
      createdAt: nowIso(),
    },
  ];

  return {
    workspaces: [workspace],
    policyProfiles: policies,
    recordings,
    ingestionSessions,
    transcriptJobs,
    revisions: [draftRevision, pendingRevision],
    approvals: [
      {
        id: createId("approval"),
        recordingId: "rec-seed-approval",
        revisionId: pendingRevision.id,
        state: "pending",
        actorRole: "reviewer",
        createdAt: nowIso(),
        note: "Awaiting approver review.",
      },
    ],
    auditEvents,
  };
}

function ensureFile() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });

  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, JSON.stringify(seedState(), null, 2));
  }
}

export function readState(): AppState {
  ensureFile();
  const parsed = normalizeState(
    JSON.parse(readFileSync(STATE_FILE, "utf8")) as AppState,
  );
  synchronizeOrchestration(parsed);
  writeFileSync(STATE_FILE, JSON.stringify(parsed, null, 2));
  return parsed;
}

export function writeState(state: AppState) {
  ensureFile();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function withState<T>(mutate: (state: AppState) => T): T {
  const state = readState();
  const result = mutate(state);
  writeState(state);
  return result;
}
