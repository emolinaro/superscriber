import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { asc, desc, eq } from "drizzle-orm";
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
import {
  EMPTY_AUDIT_METADATA,
  serializeAuditMetadata,
  serializeSegments,
  toApprovalRecord,
  toAuditEvent,
  toIngestionSession,
  toRecording,
  toRevision,
  toTranscriptJob,
} from "@/server/db/mappers";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  appStateMeta,
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
const STATE_VERSION = Symbol("app-state-version");
const MAX_WRITE_RETRIES = 3;
const STATE_CONFLICT_ERROR = "State changed concurrently. Retry the operation.";

type VersionedAppState = AppState & {
  [STATE_VERSION]?: number;
};

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function attachStateVersion(state: AppState, version: number) {
  Object.defineProperty(state, STATE_VERSION, {
    value: version,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return state as VersionedAppState;
}

function snapshotVersion(state: AppState) {
  return (state as VersionedAppState)[STATE_VERSION] ?? null;
}

function currentStateVersion(db: AppDatabase = getAppDb()) {
  return (
    db
      .select({ stateVersion: appStateMeta.stateVersion })
      .from(appStateMeta)
      .where(eq(appStateMeta.id, 1))
      .get()?.stateVersion ?? 0
  );
}

function isStateConflictError(error: unknown) {
  return error instanceof Error && error.message === STATE_CONFLICT_ERROR;
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
    createdByUserId: null,
    createdAt: nowIso(),
    submittedByUserId: null,
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
    createdByUserId: null,
    createdAt: nowIso(),
    submittedByUserId: null,
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
      transcriptModel: null,
      uploadedByRole: "uploader",
      uploadedByUserId: null,
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
      transcriptModel: null,
      uploadedByRole: "uploader",
      uploadedByUserId: null,
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
      transcriptModel: null,
      uploadedByRole: "uploader",
      uploadedByUserId: null,
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
      createdByUserId: null,
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
      createdByUserId: null,
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
      createdByUserId: null,
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
      transcribedUntilMs: null,
      audioDurationMs: null,
      segmentsSeen: null,
      outputRevisionId: draftRevision.id,
      lastError: null,
      lastErrorKind: null,
      lastErrorTechnical: null,
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
      transcribedUntilMs: null,
      audioDurationMs: null,
      segmentsSeen: null,
      outputRevisionId: pendingRevision.id,
      lastError: null,
      lastErrorKind: null,
      lastErrorTechnical: null,
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
      transcribedUntilMs: null,
      audioDurationMs: null,
      segmentsSeen: null,
      outputRevisionId: null,
      lastError: null,
      lastErrorKind: null,
      lastErrorTechnical: null,
      diarizationStatus: "pending",
    },
  ];

  const auditEventsState: AuditEvent[] = [
    {
      id: createId("audit"),
      workspaceId: workspace.id,
      recordingId: "rec-seed-review",
      actorRole: "system",
      actorUserId: null,
      actorDisplayName: null,
      effectiveRole: "system",
      adminActionSessionId: null,
      type: "transcription.completed",
      detail: "Seeded review item materialized for browser editing.",
      metadata: EMPTY_AUDIT_METADATA,
      createdAt: nowIso(),
    },
    {
      id: createId("audit"),
      workspaceId: workspace.id,
      recordingId: "rec-seed-approval",
      actorRole: "reviewer",
      actorUserId: null,
      actorDisplayName: null,
      effectiveRole: "reviewer",
      adminActionSessionId: null,
      type: "revision.submitted",
      detail: "Seeded approval item submitted.",
      metadata: EMPTY_AUDIT_METADATA,
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
        actorUserId: null,
        actorDisplayName: null,
        effectiveRole: "reviewer",
        adminActionSessionId: null,
        createdAt: nowIso(),
        note: "Awaiting approver review.",
      },
    ],
    auditEvents: auditEventsState,
  };
}

function ensureSeededState(db: AppDatabase = getAppDb()) {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });

  const existing = db.select({ id: workspaces.id }).from(workspaces).limit(1).get();
  if (existing) {
    return;
  }

  writeState(attachStateVersion(seedState(), currentStateVersion(db)), db);
}

function loadState(db: AppDatabase = getAppDb()): AppState {
  let attempts = 0;

  while (attempts < MAX_WRITE_RETRIES) {
    const beforeVersion = currentStateVersion(db);
    const policyRows = db.select().from(policyProfiles).orderBy(policyProfiles.id).all();
    const workspaceRows = db.select().from(workspaces).orderBy(workspaces.id).all();
    const recordingRows = db.select().from(recordings).orderBy(desc(recordings.updatedAt)).all();
    const ingestionRows = db
      .select()
      .from(ingestionSessions)
      .orderBy(desc(ingestionSessions.updatedAt))
      .all();
    const jobRows = db.select().from(transcriptJobs).orderBy(desc(transcriptJobs.updatedAt)).all();
    const revisionRows = db
      .select()
      .from(revisions)
      .orderBy(revisions.recordingId, desc(revisions.version))
      .all();
    const approvalRows = db.select().from(approvals).orderBy(desc(approvals.createdAt)).all();
    const auditRows = db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).all();
    const afterVersion = currentStateVersion(db);

    if (beforeVersion !== afterVersion) {
      attempts += 1;
      continue;
    }

    return attachStateVersion(
      {
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
        recordings: recordingRows.map(toRecording),
        ingestionSessions: ingestionRows.map(toIngestionSession),
        transcriptJobs: jobRows.map(toTranscriptJob),
        revisions: revisionRows.map(toRevision),
        approvals: approvalRows.map(toApprovalRecord),
        auditEvents: auditRows.map(toAuditEvent),
      },
      afterVersion,
    );
  }

  throw new Error(STATE_CONFLICT_ERROR);
}

export function readState(db: AppDatabase = getAppDb()): AppState {
  ensureSeededState(db);
  return loadState(db);
}

export function writeState(state: AppState, db: AppDatabase = getAppDb()) {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });

  const expectedVersion = snapshotVersion(state);
  let nextVersion = 0;

  db.transaction((tx) => {
    const currentVersion =
      tx
        .select({ stateVersion: appStateMeta.stateVersion })
        .from(appStateMeta)
        .where(eq(appStateMeta.id, 1))
        .get()?.stateVersion ?? 0;

    if (expectedVersion !== null && currentVersion !== expectedVersion) {
      throw new Error(STATE_CONFLICT_ERROR);
    }

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
            createdByUserId: revision.createdByUserId,
            createdAt: revision.createdAt,
            submittedByUserId: revision.submittedByUserId,
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
            metadata: serializeAuditMetadata(event.metadata),
          })),
        )
        .run();
    }
    nextVersion = currentVersion + 1;
    tx.update(appStateMeta)
      .set({
        stateVersion: nextVersion,
      })
      .where(eq(appStateMeta.id, 1))
      .run();
  });

  attachStateVersion(state, nextVersion);
}

export function readSynchronizedState(db: AppDatabase = getAppDb()) {
  if (getOrchestrationConfig().mode !== "mock") {
    return readState(db);
  }

  let attempts = 0;
  while (attempts < MAX_WRITE_RETRIES) {
    const state = readState(db);
    const before = JSON.stringify(state);
    synchronizeOrchestration(state);
    if (JSON.stringify(state) === before) {
      return state;
    }

    try {
      writeState(state, db);
      return state;
    } catch (error) {
      if (!isStateConflictError(error)) {
        throw error;
      }
      attempts += 1;
    }
  }

  throw new Error(STATE_CONFLICT_ERROR);
}

export function withState<T>(mutate: (state: AppState) => T, db: AppDatabase = getAppDb()): T {
  let attempts = 0;
  while (attempts < MAX_WRITE_RETRIES) {
    const state = readState(db);

    try {
      const result = mutate(state);
      writeState(state, db);
      return result;
    } catch (error) {
      if (!isStateConflictError(error)) {
        throw error;
      }
      attempts += 1;
    }
  }

  throw new Error(STATE_CONFLICT_ERROR);
}
