import { desc } from "drizzle-orm";
import { describePolicyProfile, evaluatePolicy } from "@/domain/policy";
import type {
  ApprovalRecord,
  PolicyProfileId,
  Principal,
  Recording,
  TranscriptRevision,
} from "@/domain/models";
import { listAssignableUsers, listLocalUsers } from "@/server/access/service";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  toApprovalRecord,
  toRecording,
  toRecordingAssignment,
  toRevision,
} from "@/server/db/mappers";
import { approvals, recordingAssignments, recordings, revisions, workspaces } from "@/server/db/schema";
import { formatDateTimeIso, formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import {
  buildRecordingHref,
  deriveStageForSelection,
  formatWorkflowStageLabel,
} from "@/server/casefile/read-model";

export type AdministrationAccountsViewModel = {
  section: "accounts";
  query: string;
  columns: Array<{ id: string; label: string }>;
  users: Array<{
    id: string;
    displayName: string;
    email: string;
    role: Principal["role"];
    roleLabel: string;
    activeAssignmentCount: number;
    createdAt: string;
    createdAtLabel: string;
    createdAtIso: string;
  }>;
};

export type AdministrationAssignmentsViewModel = {
  section: "assignments";
  filters: {
    recordingId: string | null;
    userId: string | null;
    role: "reviewer" | "approver" | null;
    status: "active" | "history" | "completed" | "removed";
    from: string | null;
    to: string | null;
  };
  columns: Array<{ id: string; label: string }>;
  stateOptions: Array<{ id: string; label: string }>;
  recordings: Array<{
    recordingId: string;
    title: string;
    stageLabel: string;
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
    role: "reviewer" | "approver";
    roleLabel: string;
    status: "active" | "completed" | "removed";
    statusLabel: string;
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

const ASSIGNMENT_COLUMNS = [
  { id: "recording", label: "Recording" },
  { id: "user", label: "Assignee" },
  { id: "role", label: "Role" },
  { id: "status", label: "Status" },
  { id: "updatedAt", label: "Updated" },
] as const;

const ASSIGNMENT_STATUS_OPTIONS = [
  { id: "active", label: "Active" },
  { id: "history", label: "History" },
  { id: "completed", label: "Completed" },
  { id: "removed", label: "Removed" },
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
  const status = firstValue(values.status);
  return {
    recordingId: firstValue(values.recordingId) ?? null,
    userId: firstValue(values.userId) ?? null,
    role:
      firstValue(values.role) === "reviewer" || firstValue(values.role) === "approver"
        ? (firstValue(values.role) as "reviewer" | "approver")
        : null,
    status:
      status === "history" || status === "completed" || status === "removed"
        ? status
        : "active",
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

function matchesStatus(
  status: AdministrationAssignmentsViewModel["filters"]["status"],
  assignmentStatus: "active" | "completed" | "removed",
) {
  if (status === "history") {
    return assignmentStatus !== "active";
  }

  return assignmentStatus === status;
}

function statusLabel(status: "active" | "completed" | "removed") {
  return status.charAt(0).toUpperCase() + status.slice(1);
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
      label: "Media playback",
      uploader: allowedText(uploader.canViewMedia),
      reviewer: allowedText(reviewer.canViewMedia),
      approver: allowedText(approver.canViewMedia),
      admin: allowedText(admin.canViewMedia),
    },
    {
      id: "raw-download",
      label: "Raw media download",
      uploader: allowedText(uploader.canDownloadRawMedia),
      reviewer: allowedText(reviewer.canDownloadRawMedia),
      approver: allowedText(approver.canDownloadRawMedia),
      admin: allowedText(admin.canDownloadRawMedia),
    },
    {
      id: "draft-edit",
      label: "Draft edit",
      uploader: allowedText(uploader.canEditDraft),
      reviewer: allowedText(reviewer.canEditDraft),
      approver: allowedText(approver.canEditDraft),
      admin: allowedText(admin.canEditDraft),
    },
    {
      id: "submit",
      label: "Submit for approval",
      uploader: allowedText(uploader.canSubmitForApproval),
      reviewer: allowedText(reviewer.canSubmitForApproval),
      approver: allowedText(approver.canSubmitForApproval),
      admin: allowedText(admin.canSubmitForApproval),
    },
    {
      id: "withdraw",
      label: "Withdraw submission",
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

  const section = firstValue(values.section);
  if (section === "assignments") {
    const filters = parseAssignmentFilters(values);
    const recordingMap = loadRecordingMap(db);
    const revisionMap = loadRevisionMap(db);
    const decisionMap = loadDecisionMap(db);
    const userMap = new Map(listLocalUsers(db).map((user) => [user.id, user]));
    const assignments = db
      .select()
      .from(recordingAssignments)
      .orderBy(desc(recordingAssignments.updatedAt))
      .all()
      .map(toRecordingAssignment)
      .filter((assignment) => matchesStatus(filters.status, assignment.status))
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
          role: assignment.assignmentRole,
          roleLabel: formatRoleLabel(assignment.assignmentRole),
          status: assignment.status,
          statusLabel: statusLabel(assignment.status),
          updatedAt: assignment.updatedAt,
          updatedAtLabel: formatDateTimeUtc(assignment.updatedAt),
          updatedAtIso: formatDateTimeIso(assignment.updatedAt),
          href: buildRecordingHref(assignment.recordingId, assignment.completedRevisionId),
        };
      });

    return {
      section: "assignments",
      filters,
      columns: [...ASSIGNMENT_COLUMNS],
      stateOptions: [...ASSIGNMENT_STATUS_OPTIONS],
      recordings: Array.from(recordingMap.values()).map((recording) => ({
        recordingId: recording.id,
        title: recording.title,
        stageLabel: stageLabelForRecording(recording, revisionMap, decisionMap),
      })),
      assignableUsers: listAssignableUsers(db).map((user) => ({
        id: user.id,
        displayName: user.displayName,
        role: user.role as "reviewer" | "approver",
      })),
      assignments,
    };
  }

  if (section === "policy") {
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
  const users = listLocalUsers(db)
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
      createdAt: user.createdAt,
      createdAtLabel: formatDateTimeUtc(user.createdAt),
      createdAtIso: formatDateTimeIso(user.createdAt),
    }));

  return {
    section: "accounts",
    query,
    columns: [...ACCOUNT_COLUMNS],
    users,
  };
}
