import { desc, eq } from "drizzle-orm";
import { evaluatePolicy } from "@/domain/policy";
import {
  deriveWorkflowStage,
  type CasefileWorkflowStage,
  type WorkflowOriginDecision,
} from "@/domain/casefile";
import type {
  ApprovalRecord,
  AuditEvent,
  IngestionSession,
  Principal,
  Recording,
  RecordingAssignment,
  RecordingSource,
  TranscriptJob,
  TranscriptRevision,
  TranscriptSegment,
  UserRole,
  PolicyProfileId,
} from "@/domain/models";
import { resolveCasefileAccess, type CasefileAccessGrant } from "@/server/access/service";
import { resolveActionMode } from "@/server/casefile/action-mode";
import {
  deriveCasefileCapabilities,
  type CapabilityKey,
  type CasefileCapabilities,
} from "@/server/casefile/capabilities";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  toApprovalRecord,
  toAuditEvent,
  toIngestionSession,
  toRecording,
  toRecordingAssignment,
  toRevision,
  toTranscriptJob,
} from "@/server/db/mappers";
import {
  approvals,
  auditEvents,
  ingestionSessions,
  recordingAssignments,
  recordings,
  revisions,
  transcriptJobs,
  users,
  workspaces,
} from "@/server/db/schema";
import { formatDateTimeIso, formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import { readSynchronizedState } from "@/server/store";

const STAGE_LABELS: Record<CasefileWorkflowStage, string> = {
  needs_ingest_attention: "Needs ingest attention",
  verifying: "Verifying",
  transcribing: "Transcribing",
  pending_approval: "Pending approval",
  approved: "Approved",
  changes_requested: "Changes requested",
  reopened: "Reopened",
  draft_review: "Draft review",
};

const REVISION_STATE_LABELS: Record<TranscriptRevision["state"], string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
  changes_requested: "Changes requested",
};

const DECISION_LABELS: Record<ApprovalRecord["state"], string> = {
  not_submitted: "Not submitted",
  pending: "Pending approval",
  approved: "Approved",
  rejected: "Changes requested (legacy)",
  reopened: "Reopened",
  withdrawn: "Withdrawn",
  changes_requested: "Changes requested",
};

const NEXT_ACTION_LABELS: Array<{
  capability: CapabilityKey;
  label: string;
}> = [
  { capability: "canEdit", label: "Continue editing" },
  { capability: "canSubmit", label: "Submit for approval" },
  { capability: "canWithdraw", label: "Withdraw submission" },
  { capability: "canApprove", label: "Approve transcript" },
  { capability: "canRequestChanges", label: "Request changes" },
  { capability: "canReopen", label: "Reopen transcript" },
  { capability: "canExport", label: "Export approved transcript" },
];

export type CasefileRevisionViewModel = {
  id: string;
  version: number;
  state: TranscriptRevision["state"];
  stateLabel: string;
  summary: string;
  createdAt: string;
  createdAtLabel: string;
  createdAtIso: string;
  submittedAt: string | null;
  approvedAt: string | null;
  submittedByDisplay: string | null;
  basedOnRevisionId?: string | null;
  segments?: TranscriptSegment[];
};

export type CasefileDecisionViewModel = {
  id: string;
  revisionId: string;
  state: ApprovalRecord["state"];
  label: string;
  actorRole: ApprovalRecord["actorRole"];
  effectiveRole: ApprovalRecord["effectiveRole"];
  actorDisplay: string;
  note: string | null;
  createdAt: string;
  createdAtLabel: string;
  createdAtIso: string;
};

export type CasefileAuditViewModel = {
  id: string;
  type: AuditEvent["type"];
  detail: string;
  actorRole: AuditEvent["actorRole"];
  effectiveRole: AuditEvent["effectiveRole"];
  actorDisplay: string;
  createdAt: string;
  createdAtLabel: string;
  createdAtIso: string;
};

export type CasefileAssignmentViewModel = {
  id: string;
  userDisplay: string;
  assignmentRole: RecordingAssignment["assignmentRole"];
  status: RecordingAssignment["status"];
  createdAt: string;
  createdAtLabel: string;
  createdAtIso: string;
  endedAt: string | null;
  endedAtLabel: string | null;
  completedRevisionLabel: string | null;
};

export type CasefileNextActionViewModel = {
  capability: CapabilityKey;
  label: string;
};

export type AdminActionModeOptionViewModel = {
  effectiveRole: "reviewer" | "approver";
};

export type CasefileViewModel = {
  statusOnly: boolean;
  recordingId: string;
  workspaceId: string;
  title: string;
  source: RecordingSource;
  sourceLabel: string;
  stage: CasefileWorkflowStage;
  stageLabel: string;
  updatedAt: string;
  updatedAtLabel: string;
  updatedAtIso: string;
  assignmentLabel: string;
  historicalLabel: string | null;
  access: CasefileAccessGrant & {
    historical: boolean;
  };
  actionMode: {
    id: string;
    effectiveRole: "reviewer" | "approver";
    expiresAt: string;
    purpose: string;
    adminDisplayName: string;
    baseRole: "admin";
  } | null;
  adminActionModeOptions: AdminActionModeOptionViewModel[];
  capabilities: CasefileCapabilities;
  media: {
    kind: Recording["mediaKind"];
    url: string | null;
    denialReason: string | null;
  };
  processing: {
    active: boolean;
    integrityState: Recording["integrityState"];
    transcriptJobState: Recording["transcriptJobState"];
    progressPercent: number | null;
    etaSeconds: number | null;
    transcribedUntilMs: number | null;
    audioDurationMs: number | null;
    segmentsSeen: number | null;
    verificationSummary: string | null;
    recoveryHint: string | null;
  };
  provenance: {
    languageHint: string;
    originalFileName: string | null;
    verificationSummary: string | null;
  };
  policy: {
    mediaAccessLabel: string;
    transcriptExportLabel: string;
    draftEditLabel: string;
    approvalLabel: string;
    reopenLabel: string;
  };
  revision: CasefileRevisionViewModel | null;
  /** The LIVE ledger-active revision id (recording.currentRevisionId). On a
     ?revision=<archived id> deep link, `revision` above is the VIEWED snapshot,
     so consumers distinguishing "currently viewed" from "active" must use
     this id (D-8 deep links). */
  activeRevisionId: string | null;
  revisions: CasefileRevisionViewModel[];
  /** demo-diff-highlights (casefile UX batch): inline "Edited vs vN" markers
     on the viewed revision, when it derives from an in-casefile parent. */
  diffHighlight: { parentVersion: number; editedSegmentIds: string[] } | null;
  assignments: CasefileAssignmentViewModel[];
  decisions: CasefileDecisionViewModel[];
  audit: CasefileAuditViewModel[];
  nextActions: CasefileNextActionViewModel[];
};

function accessDenied(): never {
  throw new CasefileCommandError(
    "ACCESS_DENIED",
    "This casefile is not available to your account.",
  );
}

function loadRecording(db: AppDatabase, recordingId: string) {
  const row = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
  return row ? toRecording(row) : null;
}

function loadWorkspacePolicyProfileId(db: AppDatabase, workspaceId: string) {
  const workspace = db
    .select({ policyProfileId: workspaces.policyProfileId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();

  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} is missing.`);
  }

  return workspace.policyProfileId;
}

function loadRevisionMap(db: AppDatabase, recordingId: string) {
  return db
    .select()
    .from(revisions)
    .where(eq(revisions.recordingId, recordingId))
    .orderBy(desc(revisions.version))
    .all()
    .reduce<Map<string, TranscriptRevision>>((map, row) => {
      const revision = toRevision(row);
      map.set(revision.id, revision);
      return map;
    }, new Map());
}

function loadUserDisplayMap(db: AppDatabase) {
  return db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .all()
    .reduce<Map<string, string>>((map, row) => {
      map.set(row.id, row.displayName);
      return map;
    }, new Map());
}

function loadApprovals(db: AppDatabase, recordingId: string) {
  return db
    .select()
    .from(approvals)
    .where(eq(approvals.recordingId, recordingId))
    .orderBy(desc(approvals.createdAt))
    .all()
    .map(toApprovalRecord);
}

function loadAuditEvents(db: AppDatabase, recordingId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.recordingId, recordingId))
    .orderBy(desc(auditEvents.createdAt))
    .all()
    .map(toAuditEvent);
}

function loadAssignments(db: AppDatabase, recordingId: string) {
  return db
    .select()
    .from(recordingAssignments)
    .where(eq(recordingAssignments.recordingId, recordingId))
    .orderBy(desc(recordingAssignments.createdAt))
    .all()
    .map(toRecordingAssignment);
}

function loadIngestionSession(
  db: AppDatabase,
  recording: Recording,
): IngestionSession | null {
  if (!recording.ingestionSessionId) {
    return null;
  }

  const row = db
    .select()
    .from(ingestionSessions)
    .where(eq(ingestionSessions.id, recording.ingestionSessionId))
    .get();

  return row ? toIngestionSession(row) : null;
}

function loadTranscriptJob(
  db: AppDatabase,
  recording: Recording,
): TranscriptJob | null {
  if (!recording.transcriptJobId) {
    return null;
  }

  const row = db
    .select()
    .from(transcriptJobs)
    .where(eq(transcriptJobs.id, recording.transcriptJobId))
    .get();

  return row ? toTranscriptJob(row) : null;
}

function originDecisionForRevision(
  revision: TranscriptRevision | null,
  decisionRows: ApprovalRecord[],
): WorkflowOriginDecision {
  if (!revision) {
    return null;
  }

  const candidateIds = [revision.id, revision.basedOnRevisionId].filter(
    (value): value is string => Boolean(value),
  );
  const matchingRows = decisionRows.filter((row) => candidateIds.includes(row.revisionId));

  if (matchingRows.some((row) => row.state === "changes_requested" || row.state === "rejected")) {
    return "changes_requested";
  }

  if (matchingRows.some((row) => row.state === "reopened")) {
    return "reopened";
  }

  return null;
}

export function formatWorkflowStageLabel(stage: CasefileWorkflowStage) {
  return STAGE_LABELS[stage];
}

export function formatRecordingSourceLabel(source: RecordingSource) {
  return source === "record" ? "Recorded" : "Upload";
}

export function formatRevisionLabel(revision: Pick<TranscriptRevision, "version"> | null) {
  return revision ? `v${revision.version}` : "-";
}

export function buildRecordingHref(recordingId: string, revisionId?: string | null) {
  if (!revisionId) {
    return `/recordings/${recordingId}`;
  }

  return `/recordings/${recordingId}?revision=${encodeURIComponent(revisionId)}`;
}

export function deriveStageForSelection(
  recording: Recording,
  revision: TranscriptRevision | null,
  decisionRows: ApprovalRecord[],
) {
  const isCurrent = Boolean(revision && recording.currentRevisionId === revision.id);

  return deriveWorkflowStage({
    integrityState: recording.integrityState,
    transcriptJobState: recording.transcriptJobState,
    pendingRevisionId: isCurrent
      ? recording.pendingRevisionId
      : revision?.state === "pending_approval"
        ? revision.id
        : null,
    approvedRevisionId: isCurrent
      ? recording.approvedRevisionId
      : revision?.state === "approved"
        ? revision.id
        : null,
    currentRevisionId: revision ? revision.id : recording.currentRevisionId,
    originDecision: originDecisionForRevision(revision ?? null, decisionRows),
  });
}

function actorDisplay(
  actorDisplayName: string | null,
  actorRole: UserRole | "system",
  effectiveRole: UserRole | "system" | null,
) {
  if (actorDisplayName?.trim()) {
    return actorDisplayName;
  }

  if (actorRole === "system") {
    return "System";
  }

  const fallbackRole =
    effectiveRole && effectiveRole !== "system" ? effectiveRole : actorRole;
  return `${formatRoleLabel(fallbackRole)} (legacy account unavailable)`;
}

function submittedByDisplay(
  revision: TranscriptRevision,
  userDisplayMap: Map<string, string>,
) {
  if (!revision.submittedAt) {
    return null;
  }

  if (revision.submittedByUserId && userDisplayMap.has(revision.submittedByUserId)) {
    return userDisplayMap.get(revision.submittedByUserId) ?? null;
  }

  return "Unknown legacy submitter";
}

function toRevisionViewModel(
  revision: TranscriptRevision,
  userDisplayMap: Map<string, string>,
  options: { includeSegments?: boolean } = {},
): CasefileRevisionViewModel {
  return {
    id: revision.id,
    version: revision.version,
    state: revision.state,
    stateLabel: REVISION_STATE_LABELS[revision.state],
    summary: revision.summary,
    createdAt: revision.createdAt,
    createdAtLabel: formatDateTimeUtc(revision.createdAt),
    createdAtIso: formatDateTimeIso(revision.createdAt),
    submittedAt: revision.submittedAt,
    approvedAt: revision.approvedAt,
    submittedByDisplay: submittedByDisplay(revision, userDisplayMap),
    ...(options.includeSegments
      ? {
          basedOnRevisionId: revision.basedOnRevisionId,
          segments: revision.segments.map((segment) => ({ ...segment })),
        }
      : {}),
  };
}

function toDecisionViewModel(decision: ApprovalRecord): CasefileDecisionViewModel {
  return {
    id: decision.id,
    revisionId: decision.revisionId,
    state: decision.state,
    label: DECISION_LABELS[decision.state],
    actorRole: decision.actorRole,
    effectiveRole: decision.effectiveRole,
    actorDisplay: actorDisplay(
      decision.actorDisplayName,
      decision.actorRole,
      decision.effectiveRole,
    ),
    note: decision.note,
    createdAt: decision.createdAt,
    createdAtLabel: formatDateTimeUtc(decision.createdAt),
    createdAtIso: formatDateTimeIso(decision.createdAt),
  };
}

function toAuditViewModel(event: AuditEvent): CasefileAuditViewModel {
  return {
    id: event.id,
    type: event.type,
    detail: event.detail,
    actorRole: event.actorRole,
    effectiveRole: event.effectiveRole,
    actorDisplay: actorDisplay(event.actorDisplayName, event.actorRole, event.effectiveRole),
    createdAt: event.createdAt,
    createdAtLabel: formatDateTimeUtc(event.createdAt),
    createdAtIso: formatDateTimeIso(event.createdAt),
  };
}

function loadCompletedCutoff(grant: CasefileAccessGrant, db: AppDatabase) {
  if (grant.kind !== "completed_reviewer" && grant.kind !== "completed_approver") {
    return null;
  }

  const row = db
    .select({ endedAt: recordingAssignments.endedAt, updatedAt: recordingAssignments.updatedAt })
    .from(recordingAssignments)
    .where(eq(recordingAssignments.id, grant.assignmentId))
    .get();

  return row?.endedAt ?? row?.updatedAt ?? null;
}

function visibleRevisions(
  revisionMap: Map<string, TranscriptRevision>,
  userDisplayMap: Map<string, string>,
  cutoff: string | null,
  includeSegments = false,
) {
  // Version history (demo-governance-bringback): the history rows carry their
  // own segment snapshots so the Revisions drawer can diff any archived
  // revision against the active one without a second fetch.
  return Array.from(revisionMap.values())
    .filter((revision) => !cutoff || revision.createdAt <= cutoff)
    .map((revision) =>
      toRevisionViewModel(revision, userDisplayMap, { includeSegments }),
    );
}

function visibleDecisions(decisionRows: ApprovalRecord[], cutoff: string | null) {
  return decisionRows
    .filter((row) => !cutoff || row.createdAt <= cutoff)
    .map(toDecisionViewModel);
}

function visibleAudit(eventRows: AuditEvent[], cutoff: string | null) {
  return eventRows
    .filter((row) => !cutoff || row.createdAt <= cutoff)
    .map(toAuditViewModel);
}

function visibleAssignments(
  assignmentRows: RecordingAssignment[],
  userDisplayMap: Map<string, string>,
  revisionMap: Map<string, TranscriptRevision>,
  cutoff: string | null,
) {
  return assignmentRows
    .filter((row) => !cutoff || row.createdAt <= cutoff)
    .map((row) => ({
      id: row.id,
      userDisplay:
        userDisplayMap.get(row.userId) ?? `${formatRoleLabel(row.assignmentRole)} (legacy account unavailable)`,
      assignmentRole: row.assignmentRole,
      status: row.status,
      createdAt: row.createdAt,
      createdAtLabel: formatDateTimeUtc(row.createdAt),
      createdAtIso: formatDateTimeIso(row.createdAt),
      endedAt: row.endedAt,
      endedAtLabel: row.endedAt ? formatDateTimeUtc(row.endedAt) : null,
      completedRevisionLabel: row.completedRevisionId
        ? formatRevisionLabel(revisionMap.get(row.completedRevisionId) ?? null)
        : null,
    } satisfies CasefileAssignmentViewModel));
}

function nextActions(capabilities: CasefileCapabilities): CasefileNextActionViewModel[] {
  return NEXT_ACTION_LABELS.filter(({ capability }) => capabilities[capability]).map(
    ({ capability, label }) => ({ capability, label }),
  );
}

function adminActionModeOptions(input: {
  principal: Principal;
  grant: CasefileAccessGrant;
  policyProfileId: PolicyProfileId;
  recording: Recording;
  revision: TranscriptRevision | null;
  actionMode: CasefileViewModel["actionMode"];
}): AdminActionModeOptionViewModel[] {
  if (
    input.principal.role !== "admin" ||
    input.grant.kind !== "admin_oversight" ||
    !input.revision ||
    input.recording.currentRevisionId !== input.revision.id
  ) {
    return [];
  }

  const options: AdminActionModeOptionViewModel[] = [];

  for (const effectiveRole of ["reviewer", "approver"] as const) {
    const simulated = deriveCasefileCapabilities({
      principal: input.principal,
      grant: input.grant,
      policyProfileId: input.policyProfileId,
      recording: input.recording,
      revision: input.revision,
      actionMode: {
        id: `preview-${effectiveRole}`,
        effectiveRole,
      },
      actionModeExpired: false,
    });

    const allowed =
      effectiveRole === "reviewer"
        ? simulated.canEdit || simulated.canSave || simulated.canSubmit || simulated.canWithdraw
        : simulated.canApprove ||
          simulated.canRequestChanges ||
          simulated.canReopen ||
          simulated.canExport;

    if (allowed) {
      options.push({ effectiveRole });
    }
  }

  return options;
}

function assignmentLabelForGrant(grant: CasefileAccessGrant) {
  switch (grant.kind) {
    case "uploader_status":
      return "Uploaded by you";
    case "active_reviewer":
      return "Assigned reviewer";
    case "active_approver":
      return "Assigned approver";
    case "completed_reviewer":
    case "completed_approver":
      return "Completed snapshot";
    case "admin_oversight":
      return "Admin oversight";
  }
}

function historicalLabel(grant: CasefileAccessGrant, selectedRevision: TranscriptRevision | null, recording: Recording) {
  return selectedRevision && selectedRevision.id !== recording.currentRevisionId
    ? "Historical snapshot"
    : null;
}

function safeResolveActionMode(
  principal: Principal,
  recordingId: string,
  actionModeId: string | null | undefined,
  db: AppDatabase,
) {
  if (!actionModeId || principal.role !== "admin") {
    return {
      actionMode: null,
      actionModeExpired: false,
    };
  }

  for (const requiredEffectiveRole of ["reviewer", "approver"] as const) {
    try {
      const actionMode = resolveActionMode(
        principal,
        {
          recordingId,
          requiredEffectiveRole,
          actionModeId,
        },
        db,
      );

      if (actionMode) {
        return {
          actionMode,
          actionModeExpired: false,
        };
      }
    } catch (error) {
      if (!(error instanceof CasefileCommandError)) {
        throw error;
      }

      if (error.code === "ACTION_MODE_EXPIRED") {
        return {
          actionMode: null,
          actionModeExpired: true,
        };
      }

      if (error.code !== "ACTION_MODE_REQUIRED" && error.code !== "ACTION_MODE_ENDED") {
        throw error;
      }
    }
  }

  return {
    actionMode: null,
    actionModeExpired: false,
  };
}

function mediaView(recording: Recording, capabilities: CasefileCapabilities) {
  if (!capabilities.canViewMedia) {
    return {
      kind: recording.mediaKind,
      url: null,
      denialReason: "Media playback is denied for this role under the current policy.",
    };
  }

  if (!recording.mediaPath) {
    return {
      kind: recording.mediaKind,
      url: null,
      denialReason: "No media asset is attached to this recording yet.",
    };
  }

  return {
    kind: recording.mediaKind,
    url: `/api/media/${recording.id}`,
    denialReason: null,
  };
}

function processingRecoveryHint(
  recording: Recording,
  ingestionSession: IngestionSession | null,
  transcriptJob: TranscriptJob | null,
) {
  if (recording.integrityState === "verification_failed") {
    return ingestionSession?.verificationSummary ??
      recording.verificationSummary ??
      "Upload verification failed. Restart the ingest flow to continue.";
  }

  if (
    recording.integrityState === "capturing" ||
    recording.integrityState === "uploading" ||
    recording.integrityState === "interrupted"
  ) {
    return "Capture or upload is still in progress. Return to ingest if recovery is needed.";
  }

  if (recording.integrityState === "verifying") {
    return "Server-side verification is still running. Keep this casefile open for updates.";
  }

  if (
    recording.transcriptJobState === "queued" ||
    recording.transcriptJobState === "running" ||
    recording.transcriptJobState === "partial_result"
  ) {
    return "Keep this tab open while transcript preparation finishes.";
  }

  if (
    recording.transcriptJobState === "failed" ||
    recording.transcriptJobState === "cancelled"
  ) {
    return transcriptJob?.lastError ?? "Transcript preparation stopped before the draft was ready.";
  }

  return null;
}

function processingView(
  recording: Recording,
  ingestionSession: IngestionSession | null,
  transcriptJob: TranscriptJob | null,
) {
  return {
    active:
      recording.integrityState === "verifying" ||
      recording.transcriptJobState === "queued" ||
      recording.transcriptJobState === "running" ||
      recording.transcriptJobState === "partial_result",
    integrityState: recording.integrityState,
    transcriptJobState: recording.transcriptJobState,
    progressPercent: transcriptJob?.progressPercent ?? null,
    etaSeconds: transcriptJob?.etaSeconds ?? null,
    transcribedUntilMs: transcriptJob?.transcribedUntilMs ?? null,
    audioDurationMs: transcriptJob?.audioDurationMs ?? null,
    segmentsSeen: transcriptJob?.segmentsSeen ?? null,
    verificationSummary:
      ingestionSession?.verificationSummary ?? recording.verificationSummary ?? null,
    recoveryHint: processingRecoveryHint(recording, ingestionSession, transcriptJob),
  };
}

function policyView(
  principal: Principal,
  policyProfileId: PolicyProfileId,
  actionMode: { effectiveRole: "reviewer" | "approver" } | null,
) {
  const actorRole = actionMode?.effectiveRole ?? principal.role;
  const policy = evaluatePolicy(policyProfileId, actorRole);

  return {
    mediaAccessLabel: policy.canViewMedia ? "Allowed" : "Blocked",
    transcriptExportLabel: policy.canDownloadApprovedTranscript
      ? "Allowed after approval"
      : "Blocked until policy allows approved export",
    draftEditLabel: policy.canEditDraft ? "Allowed" : "Blocked",
    approvalLabel: policy.canApprove ? "Allowed" : "Blocked",
    reopenLabel: policy.canReopenApprovedTranscript ? "Allowed" : "Blocked",
  };
}

export function getCasefile(
  principal: Principal,
  recordingId: string,
  options: { revisionId?: string | null; actionModeId?: string | null } = {},
  db: AppDatabase = getAppDb(),
): CasefileViewModel | null {
  readSynchronizedState(db);

  const recording = loadRecording(db, recordingId);
  if (!recording) {
    return null;
  }

  const requestedRevisionId = options.revisionId ?? recording.currentRevisionId;
  const grant = resolveCasefileAccess(principal, recordingId, requestedRevisionId, db);
  if (!grant) {
    accessDenied();
  }

  const policyProfileId = loadWorkspacePolicyProfileId(db, recording.workspaceId);
  const revisionMap = loadRevisionMap(db, recording.id);
  const userDisplayMap = loadUserDisplayMap(db);
  const decisionRows = loadApprovals(db, recording.id);
  const auditRows = loadAuditEvents(db, recording.id);
  const assignmentRows = loadAssignments(db, recording.id);
  const ingestionSession = loadIngestionSession(db, recording);
  const transcriptJob = loadTranscriptJob(db, recording);
  const cutoff = loadCompletedCutoff(grant, db);
  // Version history (demo-governance-bringback): the ?revision=<id> deep link
  // must honor the contract for admins (oversight may inspect any archived
  // revision); completed grants pin to their recorded snapshot; active
  // assignments stay pinned to the CURRENT revision.
  const requestedRow =
    options.revisionId != null ? revisionMap.get(options.revisionId) ?? null : null;
  const selectedRevision =
    grant.kind === "uploader_status"
      ? null
      : grant.kind === "completed_reviewer" || grant.kind === "completed_approver"
        ? revisionMap.get(grant.revisionId) ?? null
        : options.revisionId && requestedRow && grant.kind === "admin_oversight"
          ? requestedRow
          : recording.currentRevisionId
            ? revisionMap.get(recording.currentRevisionId) ?? null
            : null;
  const { actionMode, actionModeExpired } = safeResolveActionMode(
    principal,
    recording.id,
    options.actionModeId,
    db,
  );
  const stage = deriveStageForSelection(recording, selectedRevision, decisionRows);
  // demo-diff-highlights: when the viewed revision derives from a parent
  // (based_on_revision_id), compute which segments changed versus the parent
  // so the transcript list can mark them inline. All grants with revision
  // visibility get the same read-only recall.
  let diffHighlight: { parentVersion: number; editedSegmentIds: string[] } | null = null;
  if (selectedRevision?.basedOnRevisionId) {
    const parent = revisionMap.get(selectedRevision.basedOnRevisionId);
    if (parent) {
      const byId = new Map(parent.segments.map((segment) => [segment.id, segment]));
      const editedSegmentIds = selectedRevision.segments
        .filter((segment) => {
          const previous = byId.get(segment.id);
          if (!previous) {
            return true; // added versus parent
          }
          return (
            previous.text !== segment.text ||
            previous.speakerLabel !== segment.speakerLabel
          );
        })
        .map((segment) => segment.id);
      if (editedSegmentIds.length > 0) {
        diffHighlight = { parentVersion: parent.version, editedSegmentIds };
      }
    }
  }
  const capabilities = deriveCasefileCapabilities({
    principal,
    grant,
    policyProfileId,
    recording,
    revision: selectedRevision,
    actionMode,
    actionModeExpired,
  });

  return {
    statusOnly: grant.kind === "uploader_status",
    recordingId: recording.id,
    workspaceId: recording.workspaceId,
    title: recording.title,
    source: recording.source,
    sourceLabel: formatRecordingSourceLabel(recording.source),
    stage,
    stageLabel: formatWorkflowStageLabel(stage),
    updatedAt: recording.updatedAt,
    updatedAtLabel: formatDateTimeUtc(recording.updatedAt),
    updatedAtIso: formatDateTimeIso(recording.updatedAt),
    assignmentLabel: assignmentLabelForGrant(grant),
    historicalLabel: historicalLabel(grant, selectedRevision, recording),
    access: {
      ...grant,
      historical: Boolean(selectedRevision && selectedRevision.id !== recording.currentRevisionId),
    },
    actionMode,
    adminActionModeOptions: adminActionModeOptions({
      principal,
      grant,
      policyProfileId,
      recording,
      revision: selectedRevision,
      actionMode,
    }),
    capabilities,
    media: mediaView(recording, capabilities),
    processing: processingView(recording, ingestionSession, transcriptJob),
    provenance: {
      languageHint: recording.languageHint,
      originalFileName: recording.originalFileName,
      verificationSummary:
        ingestionSession?.verificationSummary ?? recording.verificationSummary ?? null,
    },
    policy: policyView(principal, policyProfileId, actionMode),
    diffHighlight,
    revision: selectedRevision
      ? toRevisionViewModel(selectedRevision, userDisplayMap, { includeSegments: true })
      : null,
    activeRevisionId: recording.currentRevisionId,
    revisions:
      grant.kind === "uploader_status"
        ? []
        : visibleRevisions(revisionMap, userDisplayMap, cutoff, true),
    assignments:
      grant.kind === "uploader_status"
        ? []
        : visibleAssignments(assignmentRows, userDisplayMap, revisionMap, cutoff),
    decisions: grant.kind === "uploader_status" ? [] : visibleDecisions(decisionRows, cutoff),
    audit: grant.kind === "uploader_status" ? [] : visibleAudit(auditRows, cutoff),
    nextActions: nextActions(capabilities),
  };
}
