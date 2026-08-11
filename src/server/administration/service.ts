import { describePolicyProfile, evaluatePolicy } from "@/domain/policy";
import type {
  ApprovalRecord,
  AssignmentRole,
  PolicyProfileId,
  Principal,
  Recording,
  TranscriptRevision,
} from "@/domain/models";
import { POLICY_PROFILES } from "@/domain/models";
import {
  assertAssignmentCompatible,
  listAssignableUsers,
  listLocalUsers,
} from "@/server/access/service";
import { recordSecurityEvent } from "@/server/auth/security-events";
import { actorContextForPrincipal, insertAuditEvent } from "@/server/casefile/audit";
import { CasefileCommandError } from "@/server/casefile/errors";
import { loadResetMailConfig } from "@/server/auth/reset-mail-config";
import { getAppDb, resolveLedgerSnapshotDir, type AppDatabase } from "@/server/db/client";
import {
  deserializeSegments,
  toApprovalRecord,
  toRecording,
  toRecordingAssignment,
  toRevision,
} from "@/server/db/mappers";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  adminActionSessions,
  approvals,
  auditEvents,
  authControl,
  breakGlassRecoveryCodes,
  externalIdentities,
  ingestionSessions,
  recordingAssignments,
  recordings,
  revisions,
  securityEvents,
  transcriptJobs,
  users as usersTable,
  webauthnCredentials,
  workspaces,
} from "@/server/db/schema";
import { formatDateTimeIso, formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import {
  buildRecordingHref,
  deriveStageForSelection,
  formatWorkflowStageLabel,
} from "@/server/casefile/read-model";

export type AdministrationSection = "accounts" | "assignments" | "policy" | "discipline";

export type AdministrationAssignmentCompatibility = {
  allowed: boolean;
  label: "Actionable" | "Waiting" | "Reopen authority" | "Unavailable";
  reason: string | null;
};

export type BreakGlassPanelModel = {
  designation: {
    userId: string;
    displayName: string;
    updatedAt: string;
  } | null;
  viewerIsCustodian: boolean;
  enrolledKeyCount: number;
  recoveryCodeCount: number;
  adminCandidates: Array<{ id: string; displayName: string }>;
};

export type AccountRoleManagementFacts = {
  activeAssignments: {
    reviewer: number;
    approver: number;
  };
  hasActiveOidcIdentity: boolean;
  isBreakGlassAdministrator: boolean;
  isSoleActiveAdministrator: boolean;
};

export type AdministrationAccountsViewModel = {
  section: "accounts";
  query: string;
  columns: Array<{ id: string; label: string }>;
  users: Array<
    {
      id: string;
      displayName: string;
      email: string;
      role: Principal["role"];
      roleLabel: string;
      activeAssignmentCount: number;
      createdAt: string;
      createdAtLabel: string;
      createdAtIso: string;
    } & AccountRoleManagementFacts
  >;
  breakGlass: BreakGlassPanelModel;
  resetMailConfigured: boolean;
  currentUserId: string;
};

export type AdministrationAssignmentsViewModel = {
  section: "assignments";
  filters: {
    recordingId: string | null;
    userId: string | null;
    role: "reviewer" | "approver" | null;
    status: "active" | "history";
    from: string | null;
    to: string | null;
  };
  columns: Array<{ id: string; label: string }>;
  stateOptions: Array<{ id: "active" | "history"; label: string }>;
  recordings: Array<{
    recordingId: string;
    title: string;
    stageLabel: string;
    compatibility: {
      reviewer: AdministrationAssignmentCompatibility;
      approver: AdministrationAssignmentCompatibility;
    };
  }>;
  assignableUsers: Array<{
    id: string;
    displayName: string;
    role: "reviewer" | "approver";
  }>;
  assignments: Array<{
    id: string;
    recordingId: string;
    recordingTitle: string;
    stageLabel: string;
    userId: string;
    userDisplayName: string;
    userEmail: string;
    role: "reviewer" | "approver";
    roleLabel: string;
    status: "active" | "completed" | "removed";
    statusLabel: string;
    outcomeLabel: string | null;
    completedRevisionId: string | null;
    completedRevisionLabel: string | null;
    updatedAt: string;
    updatedAtLabel: string;
    updatedAtIso: string;
    href: string;
  }>;
};

export type AdministrationPolicyViewModel = {
  section: "policy";
  profile: {
    id: PolicyProfileId;
    label: string;
    description: string;
  };
  rows: Array<{
    id: string;
    label: string;
    uploader: string;
    reviewer: string;
    approver: string;
    admin: string;
  }>;
};

export type AdministrationViewModel =
  | AdministrationAccountsViewModel
  | AdministrationAssignmentsViewModel
  | AdministrationPolicyViewModel
  | AdministrationDisciplineViewModel;

export type AdministrationDisciplineViewModel = {
  section: "discipline";
  counts: {
    auditEvents: number;
    decisionRows: number;
    govActionSessions: number;
    endedAssignments: number;
    securityEvents: number;
  };
};

const ACCOUNT_COLUMNS = [
  { id: "displayName", label: "Name" },
  { id: "email", label: "Email" },
  { id: "role", label: "Role" },
  { id: "activeAssignmentCount", label: "Active assignments" },
  { id: "createdAt", label: "Created" },
] as const;

const ACTIVE_ASSIGNMENT_COLUMNS = [
  { id: "recording", label: "Recording" },
  { id: "stage", label: "Stage" },
  { id: "user", label: "Assignee" },
  { id: "role", label: "Role" },
  { id: "updatedAt", label: "Updated" },
  { id: "actions", label: "Controls" },
] as const;

const HISTORY_ASSIGNMENT_COLUMNS = [
  { id: "recording", label: "Recording" },
  { id: "user", label: "Assignee" },
  { id: "role", label: "Role" },
  { id: "outcome", label: "Outcome" },
  { id: "completedRevision", label: "Completed revision" },
  { id: "updatedAt", label: "Updated" },
] as const;

const ASSIGNMENT_STATUS_OPTIONS = [
  { id: "active", label: "Active" },
  { id: "history", label: "History" },
] as const;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function requireAdmin(principal: Principal) {
  if (principal.role !== "admin") {
    throw new CasefileCommandError(
      "ACCESS_DENIED",
      "Administration is not available to your account.",
    );
  }
}

function parseIso(value: string | string[] | undefined) {
  const candidate = firstValue(value)?.trim() ?? "";
  if (!candidate || Number.isNaN(Date.parse(candidate))) {
    return null;
  }
  return new Date(candidate).toISOString();
}

function parseAssignmentFilters(
  values: Record<string, string | string[] | undefined>,
): AdministrationAssignmentsViewModel["filters"] {
  return {
    recordingId: firstValue(values.recordingId) ?? null,
    userId: firstValue(values.userId) ?? null,
    role:
      firstValue(values.role) === "reviewer" || firstValue(values.role) === "approver"
        ? (firstValue(values.role) as "reviewer" | "approver")
        : null,
    status: firstValue(values.status) === "history" ? "history" : "active",
    from: parseIso(values.from),
    to: parseIso(values.to),
  };
}

function loadRecordingMap(db: AppDatabase) {
  return db
    .select()
    .from(recordings)
    .all()
    .reduce<Map<string, Recording>>((map, row) => {
      const recording = toRecording(row);
      map.set(recording.id, recording);
      return map;
    }, new Map());
}

function loadRevisionMap(db: AppDatabase) {
  return db
    .select()
    .from(revisions)
    .all()
    .reduce<Map<string, TranscriptRevision>>((map, row) => {
      const revision = toRevision(row);
      map.set(revision.id, revision);
      return map;
    }, new Map());
}

type DecisionRows = ApprovalRecord[];

function loadDecisionMap(db: AppDatabase) {
  return db
    .select()
    .from(approvals)
    .orderBy(desc(approvals.createdAt))
    .all()
    .map(toApprovalRecord)
    .reduce<Map<string, DecisionRows>>((map, decision) => {
      const existing = map.get(decision.recordingId) ?? [];
      existing.push(decision);
      map.set(decision.recordingId, existing);
      return map;
    }, new Map());
}

function stageLabelForRecording(
  recording: Recording,
  revisionMap: Map<string, TranscriptRevision>,
  decisionMap: Map<string, DecisionRows>,
) {
  const revision = recording.currentRevisionId
    ? revisionMap.get(recording.currentRevisionId) ?? null
    : null;
  return formatWorkflowStageLabel(
    deriveStageForSelection(recording, revision, decisionMap.get(recording.id) ?? []),
  );
}

function statusLabel(status: "active" | "completed" | "removed") {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function completedRevisionLabel(
  completedRevisionId: string | null,
  revisionMap: Map<string, TranscriptRevision>,
) {
  if (!completedRevisionId) {
    return "-";
  }

  const revision = revisionMap.get(completedRevisionId);
  return revision ? `Approved v${revision.version}` : completedRevisionId;
}

function assignmentCompatibility(
  recording: Pick<
    Recording,
    "integrityState" | "transcriptJobState" | "approvedRevisionId" | "currentRevisionId"
  >,
  role: AssignmentRole,
): AdministrationAssignmentCompatibility {
  try {
    return {
      allowed: true,
      label: assertAssignmentCompatible(recording, role),
      reason: null,
    };
  } catch (error) {
    if (error instanceof CasefileCommandError && error.code === "VALIDATION_ERROR") {
      return {
        allowed: false,
        label: "Unavailable",
        reason: error.message,
      };
    }

    throw error;
  }
}

// Ledger reset (demo-governance-bringback): the one-way wipe. Audit/decision
// ledger tables are cleared wholesale; users, recordings, revisions, jobs,
// sessions, and media are untouched. The reset ITSELF keeps exactly one
// surviving record in security_events (actor, counts, snapshot path,
// timestamp) so the namespace never lies.
function ledgerCounts(db: AppDatabase) {
  return {
    auditEvents: db.select({ id: auditEvents.id }).from(auditEvents).all().length,
    decisionRows: db.select({ id: approvals.id }).from(approvals).all().length,
    govActionSessions: db
      .select({ id: adminActionSessions.id })
      .from(adminActionSessions)
      .all().length,
    endedAssignments: db
      .select({ id: recordingAssignments.id })
      .from(recordingAssignments)
      .where(sql`${recordingAssignments.endReason} IS NOT NULL`)
      .all().length,
    securityEvents: db.select({ id: securityEvents.id }).from(securityEvents).all().length,
  };
}

// D-5 compensating control: every destructive governance control writes the
// rows it is about to delete into a JSON snapshot outside the database before
// the delete transaction runs, so forensics survive the wipe. The snapshot
// directory lives beside the database (see resolveLedgerSnapshotDir).
function writeLedgerSnapshot(
  kind: "ledger.reset" | "recording.purge",
  actorUserId: string,
  tables: Record<string, unknown[]>,
  snapshotDir: string,
) {
  mkdirSync(snapshotDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(snapshotDir, `${kind}-${stamp}.json`);
  writeFileSync(
    path,
    JSON.stringify({ type: kind, actorUserId, at: new Date().toISOString(), tables }, null, 2),
    { mode: 0o600 },
  );
  return path;
}

export function resetWorkspaceLedger(
  input: { actorUserId: string; expectedPhrase: string },
  db: AppDatabase = getAppDb(),
  snapshotDir: string = resolveLedgerSnapshotDir(),
) {
  if (input.expectedPhrase.trim() !== "RESET REQUIRED") {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Type the phrase RESET REQUIRED to confirm the ledger wipe.",
      { expectedPhrase: "Type the phrase RESET REQUIRED." },
    );
  }

  const before = ledgerCounts(db);

  // Pre-wipe export snapshot (D-5): row-level copies of every table about to
  // be cleared land OUTSIDE the database before the delete transaction, so
  // the forensic trail survives the reset even if the transaction later fails.
  const snapshotPath = writeLedgerSnapshot(
    "ledger.reset",
    input.actorUserId,
    {
      auditEvents: db.select().from(auditEvents).all(),
      approvals: db.select().from(approvals).all(),
      adminActionSessions: db.select().from(adminActionSessions).all(),
      endedAssignments: db
        .select()
        .from(recordingAssignments)
        .where(sql`${recordingAssignments.endReason} IS NOT NULL`)
        .all(),
      securityEvents: db.select().from(securityEvents).all(),
    },
    snapshotDir,
  );

  const record = db.transaction((tx) => {
    tx.delete(auditEvents).run();
    tx.delete(approvals).run();
    tx.delete(adminActionSessions).run();
    tx
      .delete(recordingAssignments)
      .where(sql`${recordingAssignments.endReason} IS NOT NULL`)
      .run();
    tx.delete(securityEvents).run();

    return recordSecurityEvent(
      {
        type: "ledger.reset",
        outcome: "success",
        userId: input.actorUserId,
        detail: `Governed ledger reset by an administrator. Cleared: ${before.auditEvents} audit events, ${before.decisionRows} decision rows, ${before.govActionSessions} governance action sessions, ${before.endedAssignments} ended assignments, ${before.securityEvents} security events. Rows were snapshotted to ${snapshotPath} before deletion.`,
        metadata: {
          clearedAuditEvents: before.auditEvents,
          clearedDecisionRows: before.decisionRows,
          clearedGovActionSessions: before.govActionSessions,
          clearedEndedAssignments: before.endedAssignments,
          clearedSecurityEvents: before.securityEvents,
          snapshotPath,
        },
      },
      tx,
    );
  });

  return { id: record, before, snapshotPath };
}

// Recording purge (demo-governance-bringback): admin-only permanent deletion
// of a recording and its casefile. The transcription-cleanup precedent
// applies: tombstone/audit discipline over disappearance - every audit/ledger
// row of the casefile is removed EXCEPT one surviving `recording.deleted`
// event in security_events, which keeps the title, recording id, actor, and
// timestamp. Per the D-5 compensating control, the whole casefile is
// snapshotted outside the database before any row is deleted.
export function deleteRecordingPermanently(
  input: { recordingId: string; expectedTitle: string; actorUserId: string },
  db: AppDatabase = getAppDb(),
  snapshotDir: string = resolveLedgerSnapshotDir(),
) {
  const row = db.select().from(recordings).where(eq(recordings.id, input.recordingId)).get();
  if (!row) {
    throw new CasefileCommandError("NOT_FOUND", "No recording with that id exists.");
  }
  if (row.title !== input.expectedTitle.trim()) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Type the recording title exactly to confirm permanent deletion.",
      { expectedTitle: "Type the recording title exactly to confirm permanent deletion." },
    );
  }

  const revisionIds = db
    .select({ id: revisions.id })
    .from(revisions)
    .where(eq(revisions.recordingId, input.recordingId))
    .all()
    .map((entry) => entry.id);

  const mediaPath = row.mediaPath;

  // Pre-delete export snapshot (D-5 compensating control).
  const snapshotPath = writeLedgerSnapshot(
    "recording.purge",
    input.actorUserId,
    {
      recording: [row],
      revisions: db.select().from(revisions).where(eq(revisions.recordingId, input.recordingId)).all(),
      approvals: db.select().from(approvals).where(eq(approvals.recordingId, input.recordingId)).all(),
      recordingAssignments: db
        .select()
        .from(recordingAssignments)
        .where(eq(recordingAssignments.recordingId, input.recordingId))
        .all(),
      adminActionSessions: db
        .select()
        .from(adminActionSessions)
        .where(eq(adminActionSessions.recordingId, input.recordingId))
        .all(),
      ingestionSessions: db
        .select()
        .from(ingestionSessions)
        .where(eq(ingestionSessions.recordingId, input.recordingId))
        .all(),
      transcriptJobs: db
        .select()
        .from(transcriptJobs)
        .where(eq(transcriptJobs.recordingId, input.recordingId))
        .all(),
      auditEvents: db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.recordingId, input.recordingId))
        .all(),
    },
    snapshotDir,
  );

  db.transaction((tx) => {
    // The surviving deletion record lands FIRST - even a mid-flight crash
    // cannot leave the deletion unlogged.
    recordSecurityEvent(
      {
        type: "recording.deleted",
        outcome: "success",
        userId: input.actorUserId,
        detail: `Recording permanently deleted by an administrator: "${row.title}". Rows were snapshotted to ${snapshotPath} before deletion.`,
        metadata: {
          recordingId: row.id,
          title: row.title,
          actorUserId: input.actorUserId,
          revisionCount: revisionIds.length,
          snapshotPath,
        },
      },
      tx,
    );

    tx.delete(recordingAssignments)
      .where(eq(recordingAssignments.recordingId, input.recordingId))
      .run();
    tx.delete(adminActionSessions)
      .where(eq(adminActionSessions.recordingId, input.recordingId))
      .run();
    tx.delete(approvals).where(eq(approvals.recordingId, input.recordingId)).run();
    tx.delete(revisions).where(eq(revisions.recordingId, input.recordingId)).run();
    tx.delete(ingestionSessions)
      .where(eq(ingestionSessions.recordingId, input.recordingId))
      .run();
    tx.delete(transcriptJobs).where(eq(transcriptJobs.recordingId, input.recordingId)).run();

    // Every audit line of the casefile dies with it - except the deletion
    // record above (security_events is global, not per-recording).
    tx.delete(auditEvents).where(eq(auditEvents.recordingId, input.recordingId)).run();

    tx.delete(recordings).where(eq(recordings.id, input.recordingId)).run();
  });

  if (mediaPath) {
    try {
      unlinkSync(mediaPath);
    } catch (error) {
      // The casefile is gone; an orphaned media artifact is acceptable. Log
      // the failure so operators can sweep the orphan.
      console.error("recording purge left an orphaned media artifact", {
        recordingId: input.recordingId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { title: row.title, revisionCount: revisionIds.length, snapshotPath };
}

// Revision recovery (demo-governance-bringback): admin recovery of an
// archived revision. The old revision is cloned into a NEW draft (provenance
// visible in the summary and the event detail), becoming the active revision.
// The lineage itself never mutates - this APPENDS one more row.
export function recoverRevisionVersion(
  input: {
    recordingId: string;
    sourceRevisionId: string;
    actorUserId: string;
  },
  db: AppDatabase = getAppDb(),
) {
  const recordingRow = db
    .select()
    .from(recordings)
    .where(eq(recordings.id, input.recordingId))
    .get();
  if (!recordingRow) {
    throw new CasefileCommandError("NOT_FOUND", "No recording with that id exists.");
  }

  const sourceRow = db
    .select()
    .from(revisions)
    .where(
      and(
        eq(revisions.id, input.sourceRevisionId),
        eq(revisions.recordingId, input.recordingId),
      ),
    )
    .get();
  if (!sourceRow) {
    throw new CasefileCommandError("NOT_FOUND", "That revision is not part of this casefile.");
  }
  if (sourceRow.id === recordingRow.currentRevisionId) {
    throw new CasefileCommandError("STATE_CHANGED", "That revision is already the active one.");
  }

  const nextVersion =
    (db
      .select({ maxVersion: sql<number | null>`MAX(version)` })
      .from(revisions)
      .where(eq(revisions.recordingId, input.recordingId))
      .get()?.maxVersion ?? 0) + 1;

  const actorRow = db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, input.actorUserId))
    .get();
  if (!actorRow) {
    throw new CasefileCommandError("ACCESS_DENIED", "The acting account no longer exists.");
  }
  const actorPrincipal: Principal = {
    userId: actorRow.id,
    email: actorRow.email,
    displayName: actorRow.displayName,
    role: actorRow.role,
  };

  const now = new Date().toISOString();
  const newRevisionId = `rev-${crypto.randomUUID()}`;
  deserializeSegments(sourceRow.segmentsJson); // shape check: the clone writes the same JSON

  db.transaction((tx) => {
    tx.insert(revisions)
      .values({
        id: newRevisionId,
        recordingId: input.recordingId,
        version: nextVersion,
        state: "draft",
        basedOnRevisionId: sourceRow.id,
        createdByRole: "admin",
        createdByUserId: input.actorUserId,
        createdAt: now,
        submittedByUserId: null,
        submittedAt: null,
        approvedAt: null,
        summary: `Recovered from v${sourceRow.version}. ${sourceRow.summary}`,
        segmentsJson: sourceRow.segmentsJson,
      })
      .run();

    tx.update(recordings)
      .set({
        currentRevisionId: newRevisionId,
        approvedRevisionId: null,
        pendingRevisionId: null,
        updatedAt: now,
      })
      .where(eq(recordings.id, input.recordingId))
      .run();

    insertAuditEvent(tx, {
      workspaceId: recordingRow.workspaceId,
      recordingId: input.recordingId,
      actor: actorContextForPrincipal(actorPrincipal),
      type: "revision.recovered",
      detail: `Recovered from revision v${sourceRow.version}; the recovered draft is now the active revision ${nextVersion}.`,
      metadata: {
        fromRevisionId: sourceRow.id,
        fromVersion: sourceRow.version,
        newRevisionId,
        newVersion: nextVersion,
      },
      createdAt: now,
    });

    try {
      recordSecurityEvent(
        {
          type: "revision.recovered",
          outcome: "success",
          userId: input.actorUserId,
          detail: `Administrator recovered revision v${sourceRow.version} as the active draft.`,
          metadata: { recordingId: input.recordingId, fromVersion: sourceRow.version },
        },
        tx,
      );
    } catch {
      // security log must never break the control operation
    }
  });

  return { recording: toRecording(recordingRow), newRevisionId, newVersion: nextVersion };
}

// Policy profile editing (demo-governance-bringback): the workspace policy
// profile is an admin-governed setting. Change it through here so the audit
// trail keeps the actor; ad-hoc SQL bypasses the security log by design.
export function setWorkspacePolicyProfile(
  input: { profileId: PolicyProfileId; actorUserId: string },
  db: AppDatabase = getAppDb(),
) {
  if (!POLICY_PROFILES.includes(input.profileId)) {
    throw new CasefileCommandError("VALIDATION_ERROR", "Unknown policy profile.");
  }

  const workspace = db.select().from(workspaces).get();
  if (!workspace) {
    throw new CasefileCommandError("NOT_FOUND", "No workspace exists yet.");
  }

  const current = workspace.policyProfileId;
  if (current === input.profileId) {
    return { profileId: current, changed: false };
  }

  db.update(workspaces)
    .set({ policyProfileId: input.profileId })
    .where(eq(workspaces.id, workspace.id))
    .run();

  try {
    recordSecurityEvent(
      {
        type: "policy.updated",
        outcome: "success",
        userId: input.actorUserId,
        detail: `Workspace policy profile changed by an administrator.`,
        metadata: { from: current, to: input.profileId },
      },
      db,
    );
  } catch {
    // security log must never break the control operation
  }

  return {
    profileId: db.select().from(workspaces).get()!.policyProfileId,
    changed: true,
  };
}

function policyProfileLabel(profileId: PolicyProfileId) {
  return profileId === "reviewable-approved-export"
    ? "Reviewable approved export"
    : "Strict";
}

function allowedText(value: boolean) {
  return value ? "Allowed" : "Denied";
}

function buildPolicyRows(profileId: PolicyProfileId) {
  const uploader = evaluatePolicy(profileId, "uploader");
  const reviewer = evaluatePolicy(profileId, "reviewer");
  const approver = evaluatePolicy(profileId, "approver");
  const admin = evaluatePolicy(profileId, "admin");

  return [
    {
      id: "playback",
      label: "Playback",
      uploader: allowedText(uploader.canViewMedia),
      reviewer: allowedText(reviewer.canViewMedia),
      approver: allowedText(approver.canViewMedia),
      admin: allowedText(admin.canViewMedia),
    },
    {
      id: "raw-download",
      label: "Raw download",
      uploader: allowedText(uploader.canDownloadRawMedia),
      reviewer: allowedText(reviewer.canDownloadRawMedia),
      approver: allowedText(approver.canDownloadRawMedia),
      admin: allowedText(admin.canDownloadRawMedia),
    },
    {
      id: "draft-edit",
      label: "Edit draft",
      uploader: allowedText(uploader.canEditDraft),
      reviewer: allowedText(reviewer.canEditDraft),
      approver: allowedText(approver.canEditDraft),
      admin: allowedText(admin.canEditDraft),
    },
    {
      id: "submit",
      label: "Submit",
      uploader: allowedText(uploader.canSubmitForApproval),
      reviewer: allowedText(reviewer.canSubmitForApproval),
      approver: allowedText(approver.canSubmitForApproval),
      admin: allowedText(admin.canSubmitForApproval),
    },
    {
      id: "withdraw",
      label: "Withdraw",
      uploader: "Denied",
      reviewer: "Allowed",
      approver: "Denied",
      admin: "Denied",
    },
    {
      id: "approve",
      label: "Approve",
      uploader: allowedText(uploader.canApprove),
      reviewer: allowedText(reviewer.canApprove),
      approver: allowedText(approver.canApprove),
      admin: allowedText(admin.canApprove),
    },
    {
      id: "request-changes",
      label: "Request changes",
      uploader: "Denied",
      reviewer: "Denied",
      approver: allowedText(approver.canApprove),
      admin: "Denied",
    },
    {
      id: "reopen",
      label: "Reopen approved",
      uploader: allowedText(uploader.canReopenApprovedTranscript),
      reviewer: allowedText(reviewer.canReopenApprovedTranscript),
      approver: allowedText(approver.canReopenApprovedTranscript),
      admin: allowedText(admin.canReopenApprovedTranscript),
    },
    {
      id: "export",
      label: "Approved export",
      uploader: allowedText(uploader.canDownloadApprovedTranscript),
      reviewer: allowedText(reviewer.canDownloadApprovedTranscript),
      approver: allowedText(approver.canDownloadApprovedTranscript),
      admin: allowedText(admin.canDownloadApprovedTranscript),
    },
    {
      id: "phone-safety",
      label: "Phone safety",
      uploader: "Server only",
      reviewer: "Server only",
      approver: "Server only",
      admin: "Server only",
    },
  ];
}

export function listAdministration(
  principal: Principal,
  values: Record<string, string | string[] | undefined> = {},
  db: AppDatabase = getAppDb(),
): AdministrationViewModel {
  requireAdmin(principal);

  if (firstValue(values.section) === "assignments") {
    const filters = parseAssignmentFilters(values);
    const recordingMap = loadRecordingMap(db);
    const revisionMap = loadRevisionMap(db);
    const decisionMap = loadDecisionMap(db);
    const userMap = new Map(listLocalUsers(db).map((user) => [user.id, user]));
    const isHistory = filters.status === "history";

    const assignments = db
      .select()
      .from(recordingAssignments)
      .orderBy(desc(recordingAssignments.updatedAt))
      .all()
      .map(toRecordingAssignment)
      .filter((assignment) =>
        isHistory ? assignment.status !== "active" : assignment.status === "active",
      )
      .filter((assignment) => !filters.recordingId || assignment.recordingId === filters.recordingId)
      .filter((assignment) => !filters.userId || assignment.userId === filters.userId)
      .filter((assignment) => !filters.role || assignment.assignmentRole === filters.role)
      .filter((assignment) => !filters.from || assignment.updatedAt >= filters.from)
      .filter((assignment) => !filters.to || assignment.updatedAt <= filters.to)
      .map((assignment) => {
        const recording = recordingMap.get(assignment.recordingId);
        const user = userMap.get(assignment.userId);

        if (!recording) {
          throw new Error(`Recording ${assignment.recordingId} is missing.`);
        }

        return {
          id: assignment.id,
          recordingId: assignment.recordingId,
          recordingTitle: recording.title,
          stageLabel: stageLabelForRecording(recording, revisionMap, decisionMap),
          userId: assignment.userId,
          userDisplayName: user?.displayName ?? `Unknown ${formatRoleLabel(assignment.assignmentRole)}`,
          userEmail: user?.email ?? "Unknown email",
          role: assignment.assignmentRole,
          roleLabel: formatRoleLabel(assignment.assignmentRole),
          status: assignment.status,
          statusLabel: statusLabel(assignment.status),
          outcomeLabel: assignment.status === "active" ? null : statusLabel(assignment.status),
          completedRevisionId: assignment.completedRevisionId,
          completedRevisionLabel:
            assignment.status === "active"
              ? null
              : completedRevisionLabel(assignment.completedRevisionId, revisionMap),
          updatedAt: assignment.updatedAt,
          updatedAtLabel: formatDateTimeUtc(assignment.updatedAt),
          updatedAtIso: formatDateTimeIso(assignment.updatedAt),
          href: buildRecordingHref(assignment.recordingId, assignment.completedRevisionId),
        };
      });

    return {
      section: "assignments",
      filters,
      columns: isHistory ? [...HISTORY_ASSIGNMENT_COLUMNS] : [...ACTIVE_ASSIGNMENT_COLUMNS],
      stateOptions: [...ASSIGNMENT_STATUS_OPTIONS],
      recordings: Array.from(recordingMap.values()).map((recording) => ({
        recordingId: recording.id,
        title: recording.title,
        stageLabel: stageLabelForRecording(recording, revisionMap, decisionMap),
        compatibility: {
          reviewer: assignmentCompatibility(recording, "reviewer"),
          approver: assignmentCompatibility(recording, "approver"),
        },
      })),
      assignableUsers: listAssignableUsers(db).map((user) => ({
        id: user.id,
        displayName: user.displayName,
        role: user.role as "reviewer" | "approver",
      })),
      assignments,
    };
  }

  if (firstValue(values.section) === "policy") {
    const workspace = db.select().from(workspaces).get();
    const profileId = workspace?.policyProfileId ?? "strict";
    return {
      section: "policy",
      profile: {
        id: profileId,
        label: policyProfileLabel(profileId),
        description: describePolicyProfile(profileId),
      },
      rows: buildPolicyRows(profileId),
    };
  }

  if (firstValue(values.section) === "discipline") {
    return {
      section: "discipline",
      counts: ledgerCounts(db),
    };
  }

  const query = firstValue(values.query)?.trim() ?? "";
  const needle = query.toLowerCase();
  const localUsers = listLocalUsers(db);
  const designationRow = db.select().from(authControl).where(eq(authControl.id, 1)).get();
  const activeAdminCount = localUsers.filter(
    (user) => user.role === "admin" && user.isActive,
  ).length;
  const activeAssignmentFacts = db
    .select({
      userId: recordingAssignments.userId,
      role: recordingAssignments.assignmentRole,
    })
    .from(recordingAssignments)
    .where(eq(recordingAssignments.status, "active"))
    .all()
    .reduce<Map<string, { reviewer: number; approver: number }>>((map, row) => {
      const counts = map.get(row.userId) ?? { reviewer: 0, approver: 0 };
      counts[row.role] += 1;
      map.set(row.userId, counts);
      return map;
    }, new Map());
  const oidcLinkedUserIds = new Set(
    db
      .select({ userId: externalIdentities.userId })
      .from(externalIdentities)
      .where(eq(externalIdentities.status, "active"))
      .all()
      .map((row) => row.userId),
  );
  const users = localUsers
    .filter((user) => {
      if (!needle) {
        return true;
      }

      return (
        user.displayName.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle) ||
        user.role.toLowerCase().includes(needle)
      );
    })
    .map((user) => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      roleLabel: formatRoleLabel(user.role),
      activeAssignmentCount: user.activeAssignmentCount,
      activeAssignments: activeAssignmentFacts.get(user.id) ?? {
        reviewer: 0,
        approver: 0,
      },
      hasActiveOidcIdentity: oidcLinkedUserIds.has(user.id),
      isBreakGlassAdministrator:
        designationRow?.breakGlassUserId === user.id,
      isSoleActiveAdministrator:
        user.role === "admin" && user.isActive && activeAdminCount === 1,
      createdAt: user.createdAt,
      createdAtLabel: formatDateTimeUtc(user.createdAt),
      createdAtIso: formatDateTimeIso(user.createdAt),
    }));

  const designee = designationRow
    ? db
        .select({ id: usersTable.id, displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, designationRow.breakGlassUserId))
        .get()
    : null;
  const breakGlass: BreakGlassPanelModel = {
    viewerIsCustodian: designationRow
      ? designationRow.breakGlassUserId === principal.userId
      : false,
    designation:
      designationRow && designee
        ? {
            userId: designee.id,
            displayName: designee.displayName,
            updatedAt: designationRow.updatedAt,
          }
        : null,
    enrolledKeyCount: designationRow
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(webauthnCredentials)
          .where(eq(webauthnCredentials.userId, designationRow.breakGlassUserId))
          .get()!.count
      : 0,
    recoveryCodeCount: designationRow
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(breakGlassRecoveryCodes)
          .where(
            and(
              eq(breakGlassRecoveryCodes.breakGlassUserId, designationRow.breakGlassUserId),
              isNull(breakGlassRecoveryCodes.usedAt),
              isNull(breakGlassRecoveryCodes.rotatedAt),
            ),
          )
          .get()!.count
      : 0,
    adminCandidates: localUsers
      .filter((user) => user.role === "admin" && user.isActive)
      .map((user) => ({ id: user.id, displayName: user.displayName })),
  };

  // Page render must not crash on a malformed seam the readiness surface
  // already reports: fall back to the always-available handoff delivery.
  let resetMailConfigured = false;
  try {
    resetMailConfigured = loadResetMailConfig().mode === "smtp";
  } catch (error) {
    console.error("reset mail configuration could not be read for the accounts view", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    section: "accounts",
    query,
    columns: [...ACCOUNT_COLUMNS],
    users,
    breakGlass,
    resetMailConfigured,
    currentUserId: principal.userId,
  };
}
