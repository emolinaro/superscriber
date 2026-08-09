import { describePolicyProfile, evaluatePolicy } from "@/domain/policy";
import type {
  ApprovalRecord,
  AssignmentRole,
  PolicyProfileId,
  Principal,
  Recording,
  TranscriptRevision,
} from "@/domain/models";
import {
  assertAssignmentCompatible,
  listAssignableUsers,
  listLocalUsers,
} from "@/server/access/service";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  toApprovalRecord,
  toRecording,
  toRecordingAssignment,
  toRevision,
} from "@/server/db/mappers";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  approvals,
  authControl,
  breakGlassRecoveryCodes,
  externalIdentities,
  recordingAssignments,
  recordings,
  revisions,
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

export type AdministrationSection = "accounts" | "assignments" | "policy";

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
  | AdministrationPolicyViewModel;

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

  return {
    section: "accounts",
    query,
    columns: [...ACCOUNT_COLUMNS],
    users,
    breakGlass,
  };
}
