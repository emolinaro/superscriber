import { desc, eq } from "drizzle-orm";
import {
  deriveWorkflowStage,
  type WorkflowOriginDecision,
  type WorkflowStageInput,
} from "@/domain/casefile";
import type { Principal, Recording, TranscriptRevision, Workspace } from "@/domain/models";
import { resolveCasefileAccess, type CasefileAccessGrant } from "@/server/access/service";
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
  segments: TranscriptRevision["segments"];
  summary: string;
  actionModeId?: string | null;
};

export type SubmitRevisionCommandInput = SaveDraftCommandInput & {
  hasUnsavedChanges: boolean;
};

type CommandActor = {
  actorRole: Principal["role"];
  actorUserId: string;
  actorDisplayName: string;
  effectiveRole: "reviewer";
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
    const row = db
      .select({ state: approvals.state })
      .from(approvals)
      .where(eq(approvals.revisionId, revisionId))
      .orderBy(desc(approvals.createdAt))
      .get();

    if (row?.state === "changes_requested" || row?.state === "reopened") {
      return row.state;
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

function staleRevisionError(
  db: AppDatabase,
  recording: Recording,
  loadedRevisionId: string,
) {
  throw new CasefileCommandError(
    "STALE_REVISION",
    "This recording changed since you opened it.",
    undefined,
    {
      recordingId: recording.id,
      loadedRevisionId,
      currentRevisionId: recording.currentRevisionId,
      pendingRevisionId: recording.pendingRevisionId,
      approvedRevisionId: recording.approvedRevisionId,
      updatedAt: recording.updatedAt,
      winningStage: deriveWorkflowStage(loadStageInput(db, recording)),
    },
  );
}

function loadCommandState(
  db: AppDatabase,
  principal: Principal,
  input: { recordingId: string; actionModeId?: string | null },
  now: string,
): LoadedCommandState {
  const recording = requireRecording(db, input.recordingId);
  const revision = recording.currentRevisionId
    ? requireRevision(db, recording.currentRevisionId)
    : null;
  const workspace = requireWorkspace(db, recording.workspaceId);
  const grant = resolveCasefileAccess(principal, recording.id, null, db);

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
      requiredEffectiveRole: "reviewer",
      actionModeId: input.actionModeId ?? null,
    } satisfies ResolveActorContextInput,
    db,
    now,
  );

  if (actorContext.effectiveRole !== "reviewer") {
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
      effectiveRole: "reviewer",
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

function requireSaveAuthority(state: LoadedCommandState, principal: Principal) {
  const capabilities = deriveCasefileCapabilities({
    principal,
    grant: state.grant,
    policyProfileId: state.workspace.policyProfileId,
    recording: state.recording,
    revision: state.revision,
    actionMode: actorActionMode(state),
  });

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
  const capabilities = deriveCasefileCapabilities({
    principal,
    grant: state.grant,
    policyProfileId: state.workspace.policyProfileId,
    recording: state.recording,
    revision: state.revision,
    actionMode: actorActionMode(state),
  });

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

function saveDraftInTransaction(
  db: AppDatabase,
  actor: CommandActor,
  recording: Recording,
  prior: TranscriptRevision,
  input: SaveDraftCommandInput,
  now: string,
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
    segments: input.segments.map((segment) => ({ ...segment })),
  };

  db.update(revisions).set({ state: "superseded" }).where(eq(revisions.id, prior.id)).run();
  db.insert(revisions).values({
    id: nextRevision.id,
    recordingId: nextRevision.recordingId,
    version: nextRevision.version,
    state: nextRevision.state,
    basedOnRevisionId: nextRevision.basedOnRevisionId,
    createdByRole: nextRevision.createdByRole,
    createdByUserId: nextRevision.createdByUserId,
    createdAt: nextRevision.createdAt,
    submittedByUserId: nextRevision.submittedByUserId,
    submittedAt: nextRevision.submittedAt,
    approvedAt: nextRevision.approvedAt,
    summary: nextRevision.summary,
    segmentsJson: serializeSegments(nextRevision.segments),
  }).run();
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
    const state = loadCommandState(db, principal, input, now);
    requireSaveAuthority(state, principal);
    const prior = currentRevisionOrThrow(state.recording, state.revision);
    assertDraftState(db, state.recording, prior, input.expectedCurrentRevisionId);
    const saved = saveDraftInTransaction(db, state.actor, state.recording, prior, input, now);

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
    const state = loadCommandState(db, principal, input, now);
    requireSubmitAuthority(state, principal);
    const current = currentRevisionOrThrow(state.recording, state.revision);
    assertDraftState(db, state.recording, current, input.expectedCurrentRevisionId);

    const target = input.hasUnsavedChanges
      ? saveDraftInTransaction(db, state.actor, state.recording, current, input, now)
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
    const approvalRow = {
      id: crypto.randomUUID(),
      recordingId: state.recording.id,
      revisionId: target.id,
      state: "pending",
      actorRole: state.actor.actorRole,
      actorUserId: state.actor.userId,
      actorDisplayName: state.actor.actorDisplayName,
      effectiveRole: state.actor.effectiveRole,
      adminActionSessionId: state.actor.adminActionSessionId,
      createdAt: now,
      note: null,
    } satisfies typeof approvals.$inferInsert;

    db.insert(approvals).values(approvalRow).run();

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
