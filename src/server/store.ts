import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { asc, desc } from "drizzle-orm";
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
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  approvals,
  auditEvents,
  ingestionSessions,
  policyProfiles,
  recordings,
  revisions,
  transcriptJobs,
  workspaces,
} from "@/server/db/schema";
import { getOrchestrationConfig } from "@/server/orchestration/config";
import { synchronizeOrchestration } from "@/server/orchestration/service";

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, "data");
export const MEDIA_DIR = join(DATA_DIR, "media");

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

  const recordingsState: Recording[] = [
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

  const ingestionSessionsState: IngestionSession[] = [
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

  const transcriptJobsState: TranscriptJob[] = [
    {
      id: "job-seed-review",
      recordingId: "rec-seed-review",
      state: "completed",
      adapter: "mock-governed-engine",
      claimedByWorkerId: null,
      attemptCount: 1,
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
      claimedByWorkerId: null,
      attemptCount: 1,
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
      claimedByWorkerId: "seed-worker",
      attemptCount: 1,
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

  const auditEventsState: AuditEvent[] = [
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
    recordings: recordingsState,
    ingestionSessions: ingestionSessionsState,
    transcriptJobs: transcriptJobsState,
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
    auditEvents: auditEventsState,
  };
}

function serializeSegments(segments: TranscriptRevision["segments"]) {
  return JSON.stringify(segments);
}

function deserializeSegments(raw: string) {
  return JSON.parse(raw) as TranscriptRevision["segments"];
}

function ensureSeededState(db: AppDatabase = getAppDb()) {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });

  const existing = db.select({ id: workspaces.id }).from(workspaces).limit(1).get();
  if (existing) {
    return;
  }

  writeState(seedState(), db);
}

function loadState(db: AppDatabase = getAppDb()): AppState {
  const policyRows = db.select().from(policyProfiles).orderBy(policyProfiles.id).all();
  const workspaceRows = db.select().from(workspaces).orderBy(workspaces.id).all();
  const recordingRows = db.select().from(recordings).orderBy(desc(recordings.updatedAt)).all();
  const ingestionRows = db
    .select()
    .from(ingestionSessions)
    .orderBy(desc(ingestionSessions.updatedAt))
    .all();
  const jobRows = db.select().from(transcriptJobs).orderBy(desc(transcriptJobs.updatedAt)).all();
  const revisionRows = db.select().from(revisions).orderBy(revisions.recordingId, desc(revisions.version)).all();
  const approvalRows = db.select().from(approvals).orderBy(desc(approvals.createdAt)).all();
  const auditRows = db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).all();

  return {
    workspaces: workspaceRows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      policyProfileId: row.policyProfileId,
    })),
    policyProfiles: policyRows.map((row) => ({
      id: row.id,
      label: row.label,
      description: row.description,
    })),
    recordings: recordingRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      source: row.source,
      mediaKind: row.mediaKind,
      mimeType: row.mimeType,
      mediaPath: row.mediaPath,
      originalFileName: row.originalFileName,
      languageHint: row.languageHint,
      uploadedByRole: row.uploadedByRole,
      ingestionSessionId: row.ingestionSessionId,
      transcriptJobId: row.transcriptJobId,
      integrityState: row.integrityState,
      transcriptJobState: row.transcriptJobState,
      currentRevisionId: row.currentRevisionId,
      approvedRevisionId: row.approvedRevisionId,
      pendingRevisionId: row.pendingRevisionId,
      verificationSummary: row.verificationSummary,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      automationCursor: row.automationCursor,
    })),
    ingestionSessions: ingestionRows.map((row) => ({
      id: row.id,
      recordingId: row.recordingId,
      source: row.source,
      state: row.state,
      adapter: row.adapter,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      verifiedAt: row.verifiedAt,
      lastError: row.lastError,
      verificationSummary: row.verificationSummary,
      resumeToken: row.resumeToken,
      bytesReceived: row.bytesReceived,
      bytesExpected: row.bytesExpected,
    })),
    transcriptJobs: jobRows.map((row) => ({
      id: row.id,
      recordingId: row.recordingId,
      state: row.state,
      adapter: row.adapter,
      claimedByWorkerId: row.claimedByWorkerId,
      attemptCount: row.attemptCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      etaSeconds: row.etaSeconds,
      progressPercent: row.progressPercent,
      outputRevisionId: row.outputRevisionId,
      lastError: row.lastError,
      diarizationStatus: row.diarizationStatus,
    })),
    revisions: revisionRows.map((row) => ({
      id: row.id,
      recordingId: row.recordingId,
      version: row.version,
      state: row.state,
      basedOnRevisionId: row.basedOnRevisionId,
      createdByRole: row.createdByRole,
      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      approvedAt: row.approvedAt,
      summary: row.summary,
      segments: deserializeSegments(row.segmentsJson),
    })),
    approvals: approvalRows.map((row) => ({
      id: row.id,
      recordingId: row.recordingId,
      revisionId: row.revisionId,
      state: row.state,
      actorRole: row.actorRole,
      createdAt: row.createdAt,
      note: row.note,
    })),
    auditEvents: auditRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      recordingId: row.recordingId,
      actorRole: row.actorRole,
      type: row.type,
      detail: row.detail,
      createdAt: row.createdAt,
    })),
  };
}

export function readState(db: AppDatabase = getAppDb()): AppState {
  ensureSeededState(db);
  return loadState(db);
}

export function writeState(state: AppState, db: AppDatabase = getAppDb()) {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });

  db.transaction((tx) => {
    tx.delete(auditEvents).run();
    tx.delete(approvals).run();
    tx.delete(revisions).run();
    tx.delete(transcriptJobs).run();
    tx.delete(ingestionSessions).run();
    tx.delete(recordings).run();
    tx.delete(workspaces).run();
    tx.delete(policyProfiles).run();

    if (state.policyProfiles.length > 0) {
      tx.insert(policyProfiles)
        .values(
          state.policyProfiles.map((profile) => ({
            id: profile.id,
            label: profile.label,
            description: profile.description,
          })),
        )
        .run();
    }

    if (state.workspaces.length > 0) {
      tx.insert(workspaces)
        .values(
          state.workspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            policyProfileId: workspace.policyProfileId,
          })),
        )
        .run();
    }

    if (state.recordings.length > 0) {
      tx.insert(recordings)
        .values(
          state.recordings.map((recording) => ({
            ...recording,
          })),
        )
        .run();
    }

    if (state.ingestionSessions.length > 0) {
      tx.insert(ingestionSessions)
        .values(
          state.ingestionSessions.map((session) => ({
            ...session,
          })),
        )
        .run();
    }

    if (state.transcriptJobs.length > 0) {
      tx.insert(transcriptJobs)
        .values(
          state.transcriptJobs.map((job) => ({
            ...job,
          })),
        )
        .run();
    }

    if (state.revisions.length > 0) {
      tx.insert(revisions)
        .values(
          state.revisions.map((revision) => ({
            id: revision.id,
            recordingId: revision.recordingId,
            version: revision.version,
            state: revision.state,
            basedOnRevisionId: revision.basedOnRevisionId,
            createdByRole: revision.createdByRole,
            createdAt: revision.createdAt,
            submittedAt: revision.submittedAt,
            approvedAt: revision.approvedAt,
            summary: revision.summary,
            segmentsJson: serializeSegments(revision.segments),
          })),
        )
        .run();
    }

    if (state.approvals.length > 0) {
      tx.insert(approvals)
        .values(
          state.approvals.map((approval) => ({
            ...approval,
          })),
        )
        .run();
    }

    if (state.auditEvents.length > 0) {
      tx.insert(auditEvents)
        .values(
          state.auditEvents.map((event) => ({
            ...event,
          })),
        )
        .run();
    }
  });
}

export function readSynchronizedState(db: AppDatabase = getAppDb()) {
  const state = readState(db);
  if (getOrchestrationConfig().mode !== "mock") {
    return state;
  }

  const before = JSON.stringify(state);
  synchronizeOrchestration(state);
  if (JSON.stringify(state) !== before) {
    writeState(state, db);
  }
  return state;
}

export function withState<T>(mutate: (state: AppState) => T, db: AppDatabase = getAppDb()): T {
  const state = readState(db);
  const result = mutate(state);
  writeState(state, db);
  return result;
}
