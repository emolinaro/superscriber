import { and, desc, eq } from "drizzle-orm";
import {
  deriveWorkflowStage,
  validateApprovalNote,
  validateGovernedReason,
  type WorkflowOriginDecision,
  type WorkflowStageInput,
} from "@/domain/casefile";
import {
  applySpeakerRename,
  describeSpeakerRename,
  normalizeSpeakerLabels,
  planSpeakerRename,
  type SpeakerRenamePlan,
} from "@/domain/speakers";
import type {
  Principal,
  Recording,
  RecordingAssignment,
  TranscriptRevision,
  TranscriptSegmentEdit,
  Workspace,
} from "@/domain/models";
import {
  completeActiveAssignmentsForApproval,
  resolveCasefileAccess,
  type CasefileAccessGrant,
} from "@/server/access/service";
import { insertAuditEvent } from "@/server/casefile/audit";
import {
  resolveActorContext,
  type ResolveActorContextInput,
} from "@/server/casefile/action-mode";
import { deriveCasefileCapabilities } from "@/server/casefile/capabilities";
import { CasefileCommandError } from "@/server/casefile/errors";
import {
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { serializeSegments, toRecording, toRevision } from "@/server/db/mappers";
import { approvals, recordings, revisions, workspaces } from "@/server/db/schema";
import { runGovernedTransaction } from "@/server/db/transaction";

export type SaveDraftCommandInput = {
  recordingId: string;
  expectedCurrentRevisionId: string;
  edits: TranscriptSegmentEdit[];
  summary: string;
  actionModeId?: string | null;
};

export type SubmitRevisionCommandInput = SaveDraftCommandInput & {
  hasUnsavedChanges: boolean;
};

export type RenameSpeakerCommandInput = {
  recordingId: string;
  expectedCurrentRevisionId: string;
  fromSpeaker: string;
  toSpeaker: string;
  summary?: string;
  actionModeId?: string | null;
};

export type RenameSpeakerCommandResult = {
  revision: TranscriptRevision;
  rename: SpeakerRenamePlan;
};

export type WithdrawRevisionCommandInput = {
  recordingId: string;
  expectedPendingRevisionId: string;
  reason: string;
  actionModeId?: string | null;
};

export type RequestChangesCommandInput = {
  recordingId: string;
  expectedPendingRevisionId: string;
  reason: string;
  actionModeId?: string | null;
};

export type ApproveRevisionCommandInput = {
  recordingId: string;
  expectedPendingRevisionId: string;
  note: string;
  actionModeId?: string | null;
};

export type ReopenRevisionCommandInput = {
  recordingId: string;
  expectedApprovedRevisionId: string;
  reason: string;
  actionModeId?: string | null;
};

export type ApproveRevisionCommandResult = {
  revision: TranscriptRevision;
  completedAssignments: RecordingAssignment[];
};

type CommandActor = {
  actorRole: Principal["role"];
  actorUserId: string;
  actorDisplayName: string;
  effectiveRole: "reviewer" | "approver";
  adminActionSessionId: string | null;
  userId: string;
};

type LoadedCommandState = {
  workspace: Workspace;
  recording: Recording;
  revision: TranscriptRevision | null;
  grant: CasefileAccessGrant;
  actor: CommandActor;
};

function createRevisionId() {
  return `rev-${crypto.randomUUID()}`;
}

function requireRecording(db: AppDatabase, recordingId: string): Recording {
  const row = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
  if (!row) {
    throw new CasefileCommandError("NOT_FOUND", "Recording not found.");
  }

  return toRecording(row);
}

function requireRevision(db: AppDatabase, revisionId: string): TranscriptRevision {
  const row = db.select().from(revisions).where(eq(revisions.id, revisionId)).get();
  if (!row) {
    throw new CasefileCommandError("NOT_FOUND", "Transcript revision not found.");
  }

  return toRevision(row);
}

function requireWorkspace(db: AppDatabase, workspaceId: string): Workspace {
  const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!row) {
    throw new CasefileCommandError("NOT_FOUND", "Workspace not found.");
  }

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    policyProfileId: row.policyProfileId,
  };
}

function nextRevisionVersion(db: AppDatabase, recordingId: string) {
  const row = db
    .select({ version: revisions.version })
    .from(revisions)
    .where(eq(revisions.recordingId, recordingId))
    .orderBy(desc(revisions.version))
    .get();

  return (row?.version ?? 0) + 1;
}

function normalizeSummary(summary: string) {
  return summary.trim() || "Updated transcript draft.";
}

function requireExpectedCurrentRevisionId(expectedCurrentRevisionId: string) {
  if (!expectedCurrentRevisionId.trim()) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "No draft revision is loaded. Reload this recording and try again.",
      {
        expectedCurrentRevisionId:
          "No draft revision is loaded. Reload this recording and try again.",
      },
    );
  }
}

function requireExpectedPendingRevisionId(expectedPendingRevisionId: string) {
  if (!expectedPendingRevisionId.trim()) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "No pending revision is loaded. Reload this recording and try again.",
      {
        expectedPendingRevisionId:
          "No pending revision is loaded. Reload this recording and try again.",
      },
    );
  }
}

function requireExpectedApprovedRevisionId(expectedApprovedRevisionId: string) {
  if (!expectedApprovedRevisionId.trim()) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "No approved revision is loaded. Reload this recording and try again.",
      {
        expectedApprovedRevisionId:
          "No approved revision is loaded. Reload this recording and try again.",
      },
    );
  }
}

function currentRevisionOrThrow(recording: Recording, revision: TranscriptRevision | null) {
  if (!recording.currentRevisionId || !revision) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "No draft is available for this recording.",
    );
  }

  return revision;
}

function originDecisionForRevision(
  db: AppDatabase,
  revision: TranscriptRevision | null,
): WorkflowOriginDecision {
  if (!revision) {
    return null;
  }

  const candidateIds = [revision.id, revision.basedOnRevisionId].filter(
    (value): value is string => Boolean(value),
  );

  for (const revisionId of candidateIds) {
    const rows = db
      .select({ state: approvals.state })
      .from(approvals)
      .where(eq(approvals.revisionId, revisionId))
      .all();

    if (rows.some((row) => row.state === "changes_requested")) {
      return "changes_requested";
    }

    if (rows.some((row) => row.state === "reopened")) {
      return "reopened";
    }
  }

  return null;
}

function loadStageInput(db: AppDatabase, recording: Recording): WorkflowStageInput {
  const revision = recording.currentRevisionId
    ? requireRevision(db, recording.currentRevisionId)
    : null;

  return {
    integrityState: recording.integrityState,
    transcriptJobState: recording.transcriptJobState,
    pendingRevisionId: recording.pendingRevisionId,
    approvedRevisionId: recording.approvedRevisionId,
    currentRevisionId: recording.currentRevisionId,
    originDecision: originDecisionForRevision(db, revision),
  };
}

function conflictSnapshot(db: AppDatabase, recording: Recording, loadedRevisionId: string) {
  return {
    recordingId: recording.id,
    loadedRevisionId,
    currentRevisionId: recording.currentRevisionId,
    pendingRevisionId: recording.pendingRevisionId,
    approvedRevisionId: recording.approvedRevisionId,
    updatedAt: recording.updatedAt,
    winningStage: deriveWorkflowStage(loadStageInput(db, recording)),
  };
}

function staleRevisionError(
  db: AppDatabase,
  recording: Recording,
  loadedRevisionId: string,
): never {
  throw new CasefileCommandError(
    "STALE_REVISION",
    "This recording changed since you opened it.",
    undefined,
    conflictSnapshot(db, recording, loadedRevisionId),
  );
}

function stateChangedError(
  db: AppDatabase,
  recording: Recording,
  loadedRevisionId: string,
  message: string,
): never {
  throw new CasefileCommandError(
    "STATE_CHANGED",
    message,
    undefined,
    conflictSnapshot(db, recording, loadedRevisionId),
  );
}

function loadCommandState(
  db: AppDatabase,
  principal: Principal,
  input: {
    recordingId: string;
    actionModeId?: string | null;
    requiredEffectiveRole: "reviewer" | "approver";
  },
  now: string,
): LoadedCommandState {
  const recording = requireRecording(db, input.recordingId);
  const revision = recording.currentRevisionId
    ? requireRevision(db, recording.currentRevisionId)
    : null;
  const workspace = requireWorkspace(db, recording.workspaceId);
  const grant = resolveCasefileAccess(principal, recording.id, recording.currentRevisionId, db);

  if (!grant) {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "This casefile is not available to your account.",
    );
  }

  const actorContext = resolveActorContext(
    principal,
    {
      recordingId: recording.id,
      requiredEffectiveRole: input.requiredEffectiveRole,
      actionModeId: input.actionModeId ?? null,
    } satisfies ResolveActorContextInput,
    db,
    now,
  );

  if (actorContext.effectiveRole !== input.requiredEffectiveRole) {
    throw new CasefileCommandError(
      "ACTION_MODE_FORBIDDEN",
      "Your account cannot perform this governed action.",
    );
  }

  return {
    workspace,
    recording,
    revision,
    grant,
    actor: {
      actorRole: principal.role,
      actorUserId: principal.userId,
      actorDisplayName: principal.displayName,
      effectiveRole: actorContext.effectiveRole,
      adminActionSessionId: actorContext.adminActionSessionId,
      userId: principal.userId,
    },
  };
}

function actorActionMode(state: LoadedCommandState) {
  return state.actor.adminActionSessionId
    ? {
        id: state.actor.adminActionSessionId,
        effectiveRole: state.actor.effectiveRole,
      }
    : null;
}

function deriveCapabilities(state: LoadedCommandState, principal: Principal) {
  return deriveCasefileCapabilities({
    principal,
    grant: state.grant,
    policyProfileId: state.workspace.policyProfileId,
    recording: state.recording,
    revision: state.revision,
    actionMode: actorActionMode(state),
  });
}

function requireSaveAuthority(state: LoadedCommandState, principal: Principal) {
  const capabilities = deriveCapabilities(state, principal);

  if (capabilities.canSave) {
    return;
  }

  if (capabilities.denials.canSave === "not_assigned") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "An active reviewer assignment is required to edit this draft.",
    );
  }

  if (capabilities.denials.canSave === "policy") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Your account cannot edit draft transcripts.",
    );
  }
}

function requireSubmitAuthority(state: LoadedCommandState, principal: Principal) {
  const capabilities = deriveCapabilities(state, principal);

  if (capabilities.canSubmit) {
    return;
  }

  if (capabilities.denials.canSubmit === "not_assigned") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "An active reviewer assignment is required to submit this draft.",
    );
  }

  if (capabilities.denials.canSubmit === "policy") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Your account cannot submit transcripts for approval.",
    );
  }
}

function requireWithdrawAuthority(state: LoadedCommandState, principal: Principal) {
  const capabilities = deriveCapabilities(state, principal);

  if (capabilities.canWithdraw) {
    return;
  }

  if (capabilities.denials.canWithdraw === "legacy_submitter_unknown") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Submitter identity is unavailable for this legacy revision.",
    );
  }

  if (capabilities.denials.canWithdraw === "not_submitter") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Only the submitting reviewer can withdraw this revision.",
    );
  }

  if (capabilities.denials.canWithdraw === "not_assigned") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "An active reviewer assignment is required to withdraw this revision.",
    );
  }

  if (capabilities.denials.canWithdraw === "policy") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Your account cannot withdraw pending transcripts.",
    );
  }
}

function requirePendingDecisionAuthority(
  state: LoadedCommandState,
  principal: Principal,
  action: "approve" | "request_changes",
) {
  const capabilities = deriveCapabilities(state, principal);
  const key = action === "approve" ? "canApprove" : "canRequestChanges";
  const denial = capabilities.denials[key];

  if (capabilities[key] || denial === "legacy_submitter_unknown") {
    return;
  }

  if (denial === "same_submitter") {
    throw new CasefileCommandError(
      "SELF_APPROVAL_FORBIDDEN",
      "Submitters cannot approve or request changes on their own revisions.",
    );
  }

  if (denial === "not_assigned") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "An active approver assignment is required to record this decision.",
    );
  }

  if (denial === "policy") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Your account cannot approve transcripts.",
    );
  }
}

function requireReopenAuthority(state: LoadedCommandState, principal: Principal) {
  const capabilities = deriveCapabilities(state, principal);

  if (capabilities.canReopen) {
    return;
  }

  if (capabilities.denials.canReopen === "not_assigned") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "An active approver assignment is required to reopen this revision.",
    );
  }

  if (capabilities.denials.canReopen === "policy") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Your account cannot reopen approved transcripts.",
    );
  }
}

function assertDraftState(
  db: AppDatabase,
  recording: Recording,
  revision: TranscriptRevision,
  expectedCurrentRevisionId: string,
) {
  if (recording.currentRevisionId !== expectedCurrentRevisionId) {
    staleRevisionError(db, recording, expectedCurrentRevisionId);
  }

  if (revision.state === "pending_approval") {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Pending revisions cannot be edited until an approver records a decision.",
    );
  }

  if (revision.state === "approved") {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Approved revisions must be reopened before they can be edited again.",
    );
  }

  if (revision.state !== "draft") {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Only draft revisions can be changed from this command.",
    );
  }
}

function assertPendingDecisionState(
  db: AppDatabase,
  recording: Recording,
  revision: TranscriptRevision,
  expectedPendingRevisionId: string,
) {
  if (recording.pendingRevisionId !== expectedPendingRevisionId) {
    stateChangedError(
      db,
      recording,
      expectedPendingRevisionId,
      "This pending revision already transitioned. Reload this recording and try again.",
    );
  }

  if (recording.currentRevisionId !== expectedPendingRevisionId || revision.id !== expectedPendingRevisionId) {
    staleRevisionError(db, recording, expectedPendingRevisionId);
  }

  if (revision.state !== "pending_approval") {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Only pending revisions can be decided from this command.",
    );
  }
}

function assertApprovedDecisionState(
  db: AppDatabase,
  recording: Recording,
  revision: TranscriptRevision,
  expectedApprovedRevisionId: string,
) {
  if (recording.approvedRevisionId !== expectedApprovedRevisionId) {
    stateChangedError(
      db,
      recording,
      expectedApprovedRevisionId,
      "This approved revision already changed. Reload this recording and try again.",
    );
  }

  if (recording.currentRevisionId !== expectedApprovedRevisionId || revision.id !== expectedApprovedRevisionId) {
    staleRevisionError(db, recording, expectedApprovedRevisionId);
  }

  if (revision.state !== "approved") {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Only approved revisions can be reopened from this command.",
    );
  }
}

function assertCompleteSegments(
  prior: TranscriptRevision,
  segments: TranscriptRevision["segments"],
) {
  if (segments.length === 0 && prior.segments.length > 0) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "The loaded draft is missing transcript segments. Reload this recording before saving changes.",
      {
        segments:
          "The loaded draft is missing transcript segments. Reload this recording before saving changes.",
      },
    );
  }

  if (segments.length !== prior.segments.length) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Draft saves must include the full current segment array without structural changes.",
      {
        segments:
          "Draft saves must include the full current segment array without structural changes.",
      },
    );
  }

  for (const [index, segment] of segments.entries()) {
    const priorSegment = prior.segments[index];
    if (
      !priorSegment ||
      segment.id !== priorSegment.id ||
      segment.startMs !== priorSegment.startMs ||
      segment.endMs !== priorSegment.endMs
    ) {
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        "Draft saves must include the full current segment array without structural changes.",
        {
          segments:
            "Draft saves must include the full current segment array without structural changes.",
        },
      );
    }
  }
}

// Patch-based draft writes: reviewer edits arrive keyed by segment id and
// merge into the canonical skeleton of the loaded draft revision. The merge
// preserves the assertCompleteSegments invariants per segment by construction:
// the segment count and order come from the stored revision, every edit id
// must address an existing segment, and identity, timing, and worker-owned
// metadata (confidence) are copied from the stored segment and can never be
// set by a patch.
function applySegmentEdits(
  prior: TranscriptRevision,
  edits: TranscriptSegmentEdit[],
): TranscriptRevision["segments"] {
  const editBySegmentId = new Map<string, TranscriptSegmentEdit>();

  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit.id !== "string" || !edit.id) {
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        "Draft edits must address transcript segments in the loaded draft.",
        {
          edits: `Draft edit ${index + 1} must address a transcript segment in the loaded draft.`,
        },
      );
    }

    // Entries apply in payload order, so a repeated segment id folds into the
    // last value per field instead of producing a lost update inside one save.
    editBySegmentId.set(edit.id, { ...editBySegmentId.get(edit.id), ...edit });
  }

  const priorSegmentIds = new Set(prior.segments.map((segment) => segment.id));

  for (const segmentId of editBySegmentId.keys()) {
    if (!priorSegmentIds.has(segmentId)) {
      throw new CasefileCommandError(
        "VALIDATION_ERROR",
        "Draft edits must address transcript segments in the loaded draft.",
        {
          edits: "Draft edits must address transcript segments in the loaded draft. Reload this recording before saving changes.",
        },
      );
    }
  }

  return prior.segments.map((segment) => {
    const edit = editBySegmentId.get(segment.id);
    if (!edit) {
      return { ...segment };
    }

    return {
      ...segment,
      text: typeof edit.text === "string" ? edit.text : segment.text,
      speakerLabel:
        typeof edit.speakerLabel === "string" ? edit.speakerLabel : segment.speakerLabel,
    };
  });
}

function summarizeSegmentEdits(edits: TranscriptSegmentEdit[]) {
  return edits.map((edit) => ({
    segmentId: edit.id,
    fields: ["text", "speakerLabel"].filter(
      (field) => typeof edit[field as "text" | "speakerLabel"] === "string",
    ),
  }));
}

function insertRevision(db: AppDatabase, revision: TranscriptRevision) {
  db.insert(revisions).values({
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
  }).run();
}

function insertDecisionRow(
  db: AppDatabase,
  params: {
    recordingId: string;
    revisionId: string;
    state: typeof approvals.$inferInsert.state;
    actor: CommandActor;
    createdAt: string;
    note: string | null;
  },
) {
  const row = {
    id: crypto.randomUUID(),
    recordingId: params.recordingId,
    revisionId: params.revisionId,
    state: params.state,
    actorRole: params.actor.actorRole,
    actorUserId: params.actor.userId,
    actorDisplayName: params.actor.actorDisplayName,
    effectiveRole: params.actor.effectiveRole,
    adminActionSessionId: params.actor.adminActionSessionId,
    createdAt: params.createdAt,
    note: params.note,
  } satisfies typeof approvals.$inferInsert;

  db.insert(approvals).values(row).run();
}

function cloneTransitionDraft(
  db: AppDatabase,
  prior: TranscriptRevision,
  actor: CommandActor,
  now: string,
): TranscriptRevision {
  return {
    id: createRevisionId(),
    recordingId: prior.recordingId,
    version: nextRevisionVersion(db, prior.recordingId),
    state: "draft",
    basedOnRevisionId: prior.id,
    createdByRole: actor.effectiveRole,
    createdByUserId: actor.userId,
    createdAt: now,
    submittedByUserId: null,
    submittedAt: null,
    approvedAt: null,
    summary: prior.summary,
    segments: prior.segments.map((segment) => ({ ...segment })),
  };
}

function saveDraftInTransaction(
  db: AppDatabase,
  actor: CommandActor,
  recording: Recording,
  prior: TranscriptRevision,
  input: { segments: TranscriptRevision["segments"]; summary: string },
  now: string,
  options: { preserveSpeakerLabels?: boolean } = {},
) {
  assertCompleteSegments(prior, input.segments);

  const nextRevision: TranscriptRevision = {
    id: createRevisionId(),
    recordingId: recording.id,
    version: nextRevisionVersion(db, recording.id),
    state: "draft",
    basedOnRevisionId: prior.id,
    createdByRole: actor.effectiveRole,
    createdByUserId: actor.userId,
    createdAt: now,
    submittedByUserId: null,
    submittedAt: null,
    approvedAt: null,
    summary: normalizeSummary(input.summary),
    segments: options.preserveSpeakerLabels
      ? input.segments.map((segment) => ({ ...segment }))
      : normalizeSpeakerLabels(input.segments),
  };

  db.update(revisions).set({ state: "superseded" }).where(eq(revisions.id, prior.id)).run();
  insertRevision(db, nextRevision);
  db.update(recordings)
    .set({
      currentRevisionId: nextRevision.id,
      pendingRevisionId: null,
      updatedAt: now,
    })
    .where(eq(recordings.id, recording.id))
    .run();

  return nextRevision;
}

export function saveDraftCommand(
  principal: Principal,
  input: SaveDraftCommandInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): TranscriptRevision {
  requireExpectedCurrentRevisionId(input.expectedCurrentRevisionId);

  return runGovernedTransaction((db, now) => {
    const state = loadCommandState(db, principal, {
      ...input,
      requiredEffectiveRole: "reviewer",
    }, now);
    requireSaveAuthority(state, principal);
    const prior = currentRevisionOrThrow(state.recording, state.revision);
    assertDraftState(db, state.recording, prior, input.expectedCurrentRevisionId);
    const mergedSegments = applySegmentEdits(prior, input.edits);
    const saved = saveDraftInTransaction(db, state.actor, state.recording, prior, {
      segments: mergedSegments,
      summary: input.summary,
    }, now);

    insertAuditEvent(db, {
      workspaceId: state.workspace.id,
      recordingId: state.recording.id,
      actor: state.actor,
      type: "revision.saved",
      detail: `Draft revision ${saved.version} saved.`,
      metadata: {
        priorRevisionId: prior.id,
        revisionId: saved.id,
        version: saved.version,
        edits: summarizeSegmentEdits(input.edits),
      },
      createdAt: now,
    });

    return saved;
  }, bundle);
}

export function submitRevisionCommand(
  principal: Principal,
  input: SubmitRevisionCommandInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): TranscriptRevision {
  requireExpectedCurrentRevisionId(input.expectedCurrentRevisionId);

  return runGovernedTransaction((db, now) => {
    const state = loadCommandState(db, principal, {
      ...input,
      requiredEffectiveRole: "reviewer",
    }, now);
    requireSubmitAuthority(state, principal);
    const current = currentRevisionOrThrow(state.recording, state.revision);
    assertDraftState(db, state.recording, current, input.expectedCurrentRevisionId);

    const target = input.hasUnsavedChanges
      ? saveDraftInTransaction(db, state.actor, state.recording, current, {
          segments: applySegmentEdits(current, input.edits),
          summary: input.summary,
        }, now)
      : current;

    db.update(revisions)
      .set({
        state: "pending_approval",
        submittedAt: now,
        submittedByUserId: state.actor.userId,
      })
      .where(eq(revisions.id, target.id))
      .run();
    db.update(recordings)
      .set({
        currentRevisionId: target.id,
        pendingRevisionId: target.id,
        updatedAt: now,
      })
      .where(eq(recordings.id, state.recording.id))
      .run();

    insertDecisionRow(db, {
      recordingId: state.recording.id,
      revisionId: target.id,
      state: "pending",
      actor: state.actor,
      createdAt: now,
      note: null,
    });

    insertAuditEvent(db, {
      workspaceId: state.workspace.id,
      recordingId: state.recording.id,
      actor: state.actor,
      type: "revision.submitted",
      detail: `Revision ${target.version} submitted for approval.`,
      metadata: {
        revisionId: target.id,
        version: target.version,
        internalSave: input.hasUnsavedChanges,
        edits: input.hasUnsavedChanges ? summarizeSegmentEdits(input.edits) : [],
      },
      createdAt: now,
    });

    return {
      ...target,
      state: "pending_approval",
      submittedAt: now,
      submittedByUserId: state.actor.userId,
    };
  }, bundle);
}

export function renameSpeakerCommand(
  principal: Principal,
  input: RenameSpeakerCommandInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): RenameSpeakerCommandResult {
  requireExpectedCurrentRevisionId(input.expectedCurrentRevisionId);

  return runGovernedTransaction((db, now) => {
    const state = loadCommandState(db, principal, {
      ...input,
      requiredEffectiveRole: "reviewer",
    }, now);
    requireSaveAuthority(state, principal);
    const prior = currentRevisionOrThrow(state.recording, state.revision);
    assertDraftState(db, state.recording, prior, input.expectedCurrentRevisionId);

    // Plan and apply against the stored draft, not a client-computed segment
    // array: the command owns the batch math so a stale or tampered payload
    // cannot rename fewer or different segments than the summary promised.
    const rename = planSpeakerRename(prior.segments, input.fromSpeaker, input.toSpeaker);
    const renamedSegments = applySpeakerRename(prior.segments, rename.fromSpeaker, rename.toSpeaker);

    const saved = saveDraftInTransaction(db, state.actor, state.recording, prior, {
      segments: renamedSegments,
      summary:
        input.summary?.trim() ||
        `Renamed speaker "${rename.fromSpeaker}" to "${rename.toSpeaker}".`,
    }, now, { preserveSpeakerLabels: true });

    insertAuditEvent(db, {
      workspaceId: state.workspace.id,
      recordingId: state.recording.id,
      actor: state.actor,
      type: "revision.speakers_renamed",
      detail: `${describeSpeakerRename(rename)} Saved as draft revision ${saved.version}.`,
      metadata: {
        priorRevisionId: prior.id,
        revisionId: saved.id,
        version: saved.version,
        fromSpeaker: rename.fromSpeaker,
        toSpeaker: rename.toSpeaker,
        renamedSegmentCount: rename.renamedSegmentCount,
        existingTargetSegmentCount: rename.existingTargetSegmentCount,
        mergedIntoExisting: rename.mergesWithExisting,
      },
      createdAt: now,
    });

    return { revision: saved, rename };
  }, bundle);
}

export function withdrawRevisionCommand(
  principal: Principal,
  input: WithdrawRevisionCommandInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): TranscriptRevision {
  requireExpectedPendingRevisionId(input.expectedPendingRevisionId);

  return runGovernedTransaction((db, now) => {
    const state = loadCommandState(db, principal, {
      ...input,
      requiredEffectiveRole: "reviewer",
    }, now);
    requireWithdrawAuthority(state, principal);
    const pending = currentRevisionOrThrow(state.recording, state.revision);
    assertPendingDecisionState(db, state.recording, pending, input.expectedPendingRevisionId);

    if (!pending.submittedByUserId) {
      throw new CasefileCommandError(
        "ACCESS_DENIED",
        "Submitter identity is unavailable for this legacy revision.",
      );
    }

    // Admin ledger access (captain ruling): the submitter-only withdrawal
    // rule binds non-admin roles. An administrator reaches this branch only
    // under a validated reviewer action-mode session (loadCommandState and
    // the capability gate fail closed without one), so the override never
    // weakens attribution: the decision and audit rows record the acting
    // admin, the reviewer effective role, and the action-mode session.
    if (pending.submittedByUserId !== state.actor.userId && state.actor.actorRole !== "admin") {
      throw new CasefileCommandError(
        "ACCESS_DENIED",
        "Only the submitting reviewer can withdraw this revision.",
      );
    }

    const reason = validateGovernedReason(input.reason);
    const draft = cloneTransitionDraft(db, pending, state.actor, now);

    const result = db.update(recordings)
      .set({
        currentRevisionId: draft.id,
        pendingRevisionId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(recordings.id, state.recording.id),
          eq(recordings.currentRevisionId, input.expectedPendingRevisionId),
          eq(recordings.pendingRevisionId, input.expectedPendingRevisionId),
        ),
      )
      .run();

    if (result.changes === 0) {
      stateChangedError(
        db,
        requireRecording(db, state.recording.id),
        input.expectedPendingRevisionId,
        "This pending revision already transitioned. Reload this recording and try again.",
      );
    }

    db.update(revisions).set({ state: "withdrawn" }).where(eq(revisions.id, pending.id)).run();
    insertRevision(db, draft);
    insertDecisionRow(db, {
      recordingId: state.recording.id,
      revisionId: pending.id,
      state: "withdrawn",
      actor: state.actor,
      createdAt: now,
      note: reason,
    });

    insertAuditEvent(db, {
      workspaceId: state.workspace.id,
      recordingId: state.recording.id,
      actor: state.actor,
      type: "revision.withdrawn",
      detail: `Pending revision ${pending.version} withdrawn and replaced with draft ${draft.version}.`,
      metadata: {
        revisionId: pending.id,
        nextDraftRevisionId: draft.id,
        reason,
        // Admin ledger access: when the acting admin is not the submitter,
        // the audit row names both so the ledger alone shows the override.
        ...(pending.submittedByUserId !== state.actor.userId
          ? {
              submitterUserId: pending.submittedByUserId,
              submitterOverrideByAdmin: true,
            }
          : {}),
      },
      createdAt: now,
    });

    return draft;
  }, bundle);
}

export function requestChangesCommand(
  principal: Principal,
  input: RequestChangesCommandInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): TranscriptRevision {
  requireExpectedPendingRevisionId(input.expectedPendingRevisionId);

  return runGovernedTransaction((db, now) => {
    const state = loadCommandState(db, principal, {
      ...input,
      requiredEffectiveRole: "approver",
    }, now);
    requirePendingDecisionAuthority(state, principal, "request_changes");
    const pending = currentRevisionOrThrow(state.recording, state.revision);
    assertPendingDecisionState(db, state.recording, pending, input.expectedPendingRevisionId);
    const reason = validateGovernedReason(input.reason);

    // Captain ruling 2026-08-06 (corr superscriber-demo-20260805): the veto
    // binds non-admin roles only; an administrator acting under an approver
    // action-mode session may decide a revision they submitted. The decision
    // row still attributes actor + effective role + action-mode session.
    if (pending.submittedByUserId === state.actor.userId && state.actor.actorRole !== "admin") {
      throw new CasefileCommandError(
        "SELF_APPROVAL_FORBIDDEN",
        "Submitters cannot approve or request changes on their own revisions.",
      );
    }

    const draft = cloneTransitionDraft(db, pending, state.actor, now);
    const result = db.update(recordings)
      .set({
        currentRevisionId: draft.id,
        pendingRevisionId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(recordings.id, state.recording.id),
          eq(recordings.currentRevisionId, input.expectedPendingRevisionId),
          eq(recordings.pendingRevisionId, input.expectedPendingRevisionId),
        ),
      )
      .run();

    if (result.changes === 0) {
      stateChangedError(
        db,
        requireRecording(db, state.recording.id),
        input.expectedPendingRevisionId,
        "This pending revision already transitioned. Reload this recording and try again.",
      );
    }

    db.update(revisions).set({ state: "changes_requested" }).where(eq(revisions.id, pending.id)).run();
    insertRevision(db, draft);
    insertDecisionRow(db, {
      recordingId: state.recording.id,
      revisionId: pending.id,
      state: "changes_requested",
      actor: state.actor,
      createdAt: now,
      note: reason,
    });

    insertAuditEvent(db, {
      workspaceId: state.workspace.id,
      recordingId: state.recording.id,
      actor: state.actor,
      type: "approval.changes_requested",
      detail: `Revision ${pending.version} needs changes before approval.`,
      metadata: {
        revisionId: pending.id,
        nextDraftRevisionId: draft.id,
        reason,
        ...(pending.submittedByUserId === null
          ? { legacySubmitterIdentityMissing: true }
          : {}),
      },
      createdAt: now,
    });

    return draft;
  }, bundle);
}

export function approveRevisionCommand(
  principal: Principal,
  input: ApproveRevisionCommandInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): ApproveRevisionCommandResult {
  requireExpectedPendingRevisionId(input.expectedPendingRevisionId);

  return runGovernedTransaction((db, now) => {
    const state = loadCommandState(db, principal, {
      ...input,
      requiredEffectiveRole: "approver",
    }, now);
    requirePendingDecisionAuthority(state, principal, "approve");
    const pending = currentRevisionOrThrow(state.recording, state.revision);
    assertPendingDecisionState(db, state.recording, pending, input.expectedPendingRevisionId);
    const note = validateApprovalNote(input.note);

    // Captain ruling 2026-08-06 (corr superscriber-demo-20260805): same
    // supersession as requestChangesCommand - the veto binds non-admin roles
    // only; an administrator acting under an approver action-mode session may
    // decide a revision they submitted. Attribution is recorded on the row.
    if (pending.submittedByUserId === state.actor.userId && state.actor.actorRole !== "admin") {
      throw new CasefileCommandError(
        "SELF_APPROVAL_FORBIDDEN",
        "Submitters cannot approve or request changes on their own revisions.",
      );
    }

    const result = db.update(recordings)
      .set({
        currentRevisionId: pending.id,
        pendingRevisionId: null,
        approvedRevisionId: pending.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(recordings.id, state.recording.id),
          eq(recordings.currentRevisionId, input.expectedPendingRevisionId),
          eq(recordings.pendingRevisionId, input.expectedPendingRevisionId),
        ),
      )
      .run();

    if (result.changes === 0) {
      stateChangedError(
        db,
        requireRecording(db, state.recording.id),
        input.expectedPendingRevisionId,
        "This pending revision already transitioned. Reload this recording and try again.",
      );
    }

    db.update(revisions)
      .set({
        state: "approved",
        approvedAt: now,
      })
      .where(eq(revisions.id, pending.id))
      .run();
    insertDecisionRow(db, {
      recordingId: state.recording.id,
      revisionId: pending.id,
      state: "approved",
      actor: state.actor,
      createdAt: now,
      note: note || null,
    });

    const completedAssignments = completeActiveAssignmentsForApproval(
      {
        recordingId: state.recording.id,
        revisionId: pending.id,
        actor: state.actor,
      },
      db,
      now,
    );

    insertAuditEvent(db, {
      workspaceId: state.workspace.id,
      recordingId: state.recording.id,
      actor: state.actor,
      type: "approval.approved",
      detail: `Revision ${pending.version} approved.`,
      metadata: {
        revisionId: pending.id,
        note,
        completedAssignmentIds: completedAssignments.map((assignment) => assignment.id),
      },
      createdAt: now,
    });

    return {
      revision: {
        ...pending,
        state: "approved",
        approvedAt: now,
      },
      completedAssignments,
    };
  }, bundle);
}

export function reopenRevisionCommand(
  principal: Principal,
  input: ReopenRevisionCommandInput,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): TranscriptRevision {
  requireExpectedApprovedRevisionId(input.expectedApprovedRevisionId);

  return runGovernedTransaction((db, now) => {
    const state = loadCommandState(db, principal, {
      ...input,
      requiredEffectiveRole: "approver",
    }, now);
    requireReopenAuthority(state, principal);
    const approved = currentRevisionOrThrow(state.recording, state.revision);
    assertApprovedDecisionState(db, state.recording, approved, input.expectedApprovedRevisionId);
    const reason = validateGovernedReason(input.reason);
    const draft = cloneTransitionDraft(db, approved, state.actor, now);

    const result = db.update(recordings)
      .set({
        currentRevisionId: draft.id,
        approvedRevisionId: null,
        pendingRevisionId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(recordings.id, state.recording.id),
          eq(recordings.currentRevisionId, input.expectedApprovedRevisionId),
          eq(recordings.approvedRevisionId, input.expectedApprovedRevisionId),
        ),
      )
      .run();

    if (result.changes === 0) {
      stateChangedError(
        db,
        requireRecording(db, state.recording.id),
        input.expectedApprovedRevisionId,
        "This approved revision already changed. Reload this recording and try again.",
      );
    }

    insertRevision(db, draft);
    insertDecisionRow(db, {
      recordingId: state.recording.id,
      revisionId: approved.id,
      state: "reopened",
      actor: state.actor,
      createdAt: now,
      note: reason,
    });

    insertAuditEvent(db, {
      workspaceId: state.workspace.id,
      recordingId: state.recording.id,
      actor: state.actor,
      type: "approval.reopened",
      detail: `Approved revision ${approved.version} reopened as draft ${draft.version}.`,
      metadata: {
        revisionId: approved.id,
        nextDraftRevisionId: draft.id,
        reason,
      },
      createdAt: now,
    });

    return draft;
  }, bundle);
}
