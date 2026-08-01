import { desc, eq } from "drizzle-orm";
import {
  deriveWorkflowStage,
  type CasefileWorkflowStage,
  type WorkflowOriginDecision,
} from "@/domain/casefile";
import type {
  ApprovalRecord,
  AuditEvent,
  Principal,
  Recording,
  RecordingSource,
  TranscriptRevision,
  UserRole,
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
import { toApprovalRecord, toAuditEvent, toRecording, toRevision } from "@/server/db/mappers";
import {
  approvals,
  auditEvents,
  recordingAssignments,
  recordings,
  revisions,
  users,
  workspaces,
} from "@/server/db/schema";
import { formatDateTimeIso, formatDateTimeUtc, formatRoleLabel } from "@/lib/format";

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

export type CasefileNextActionViewModel = {
  capability: CapabilityKey;
  label: string;
};

export type CasefileViewModel = {
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
  access: CasefileAccessGrant & {
    historical: boolean;
  };
  actionMode: {
    id: string;
    effectiveRole: "reviewer" | "approver";
    expiresAt: string;
  } | null;
  capabilities: CasefileCapabilities;
  revision: CasefileRevisionViewModel | null;
  revisions: CasefileRevisionViewModel[];
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

function loadCompletedCutoff(
  grant: CasefileAccessGrant,
  db: AppDatabase,
) {
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
) {
  return Array.from(revisionMap.values())
    .filter((revision) => !cutoff || revision.createdAt <= cutoff)
    .map((revision) => toRevisionViewModel(revision, userDisplayMap));
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

function nextActions(capabilities: CasefileCapabilities): CasefileNextActionViewModel[] {
  return NEXT_ACTION_LABELS.filter(({ capability }) => capabilities[capability]).map(
    ({ capability, label }) => ({ capability, label }),
  );
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

export function getCasefile(
  principal: Principal,
  recordingId: string,
  options: { revisionId?: string | null; actionModeId?: string | null } = {},
  db: AppDatabase = getAppDb(),
): CasefileViewModel | null {
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
  const cutoff = loadCompletedCutoff(grant, db);
  const selectedRevision =
    grant.kind === "uploader_status"
      ? null
      : grant.kind === "completed_reviewer" || grant.kind === "completed_approver"
        ? revisionMap.get(grant.revisionId) ?? null
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
    access: {
      ...grant,
      historical: Boolean(selectedRevision && selectedRevision.id !== recording.currentRevisionId),
    },
    actionMode,
    capabilities,
    revision: selectedRevision ? toRevisionViewModel(selectedRevision, userDisplayMap) : null,
    revisions:
      grant.kind === "uploader_status"
        ? []
        : visibleRevisions(revisionMap, userDisplayMap, cutoff),
    decisions: grant.kind === "uploader_status" ? [] : visibleDecisions(decisionRows, cutoff),
    audit: grant.kind === "uploader_status" ? [] : visibleAudit(auditRows, cutoff),
    nextActions: nextActions(capabilities),
  };
}
