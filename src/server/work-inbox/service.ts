import { desc, eq } from "drizzle-orm";
import { CASEFILE_WORKFLOW_STAGES, type CasefileWorkflowStage } from "@/domain/casefile";
import type {
  ApprovalRecord,
  Principal,
  Recording,
  RecordingSource,
  TranscriptRevision,
  UserRole,
} from "@/domain/models";
import { listAssignments, resolveCasefileAccess } from "@/server/access/service";
import { getAppDb, type AppDatabase } from "@/server/db/client";
import {
  toApprovalRecord,
  toRecording,
  toRecordingAssignment,
  toRevision,
} from "@/server/db/mappers";
import { approvals, recordingAssignments, recordings, revisions } from "@/server/db/schema";
import { formatDateTimeIso, formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import {
  buildRecordingHref,
  deriveStageForSelection,
  formatRecordingSourceLabel,
  formatRevisionLabel,
  formatWorkflowStageLabel,
} from "@/server/casefile/read-model";

const ROLE_TABS: Record<UserRole, string[]> = {
  uploader: ["my-uploads", "needs-attention", "processing", "ready"],
  reviewer: ["to-review", "waiting", "completed"],
  approver: ["to-decide", "waiting", "completed"],
  admin: ["all", "needs-attention", "review", "approval", "approved"],
};

const ROLE_COPY: Record<
  UserRole,
  {
    heading: string;
    responsibility: string;
  }
> = {
  uploader: {
    heading: "Your uploads",
    responsibility: "Start recordings and track each upload through processing.",
  },
  reviewer: {
    heading: "Transcript review",
    responsibility: "Review assigned drafts and submit accurate revisions for approval.",
  },
  approver: {
    heading: "Approval decisions",
    responsibility:
      "Decide submitted revisions and reopen approved casefiles when governance requires it.",
  },
  admin: {
    heading: "Recording oversight",
    responsibility: "Monitor recordings and route governed work without acting implicitly.",
  },
};

const TAB_LABELS: Record<string, string> = {
  "my-uploads": "My uploads",
  "needs-attention": "Needs attention",
  processing: "Processing",
  ready: "Ready",
  "to-review": "To review",
  "to-decide": "To decide",
  waiting: "Waiting",
  completed: "Completed",
  all: "All",
  review: "Review",
  approval: "Approval",
  approved: "Approved",
};

const ADMIN_STAGE_SEVERITY: Record<CasefileWorkflowStage, number> = {
  needs_ingest_attention: 0,
  changes_requested: 1,
  reopened: 2,
  draft_review: 3,
  pending_approval: 4,
  verifying: 5,
  transcribing: 6,
  approved: 7,
};

export type WorkInboxFilters = {
  tab: string;
  query: string;
  stage: CasefileWorkflowStage | null;
  source: RecordingSource | null;
  assignmentUserId: string | null;
  sort: "default" | "updated_desc" | "updated_asc";
};

export type WorkInboxRow = {
  recordingId: string;
  title: string;
  stage: CasefileWorkflowStage;
  stageLabel: string;
  source: RecordingSource;
  sourceLabel: string;
  revisionLabel: string;
  progressLabel: string;
  assignmentLabel: string;
  updatedAt: string;
  updatedAtLabel: string;
  updatedAtIso: string;
  href: string;
  actionable: boolean;
  actionLabel: string | null;
  tabId: string;
  assignmentUserIds: string[];
};

export type WorkInboxViewModel = {
  role: UserRole;
  heading: string;
  responsibility: string;
  filters: WorkInboxFilters;
  tabs: Array<{
    id: string;
    label: string;
    count: number;
    href: string;
    isActive: boolean;
  }>;
  rows: WorkInboxRow[];
  nextAction: WorkInboxRow | null;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseStage(value: string | string[] | undefined) {
  const candidate = firstValue(value);
  return CASEFILE_WORKFLOW_STAGES.includes(candidate as CasefileWorkflowStage)
    ? (candidate as CasefileWorkflowStage)
    : null;
}

function parseSource(value: string | string[] | undefined) {
  const candidate = firstValue(value);
  return candidate === "upload" || candidate === "record" ? candidate : null;
}

function defaultTabForRole(role: UserRole) {
  return ROLE_TABS[role][0]!;
}

export function parseWorkInboxFilters(
  values: Record<string, string | string[] | undefined>,
  role: UserRole,
): WorkInboxFilters {
  const query = firstValue(values.query)?.trim() ?? "";
  const requestedTab = firstValue(values.tab) ?? null;
  const requestedSort = firstValue(values.sort);

  return {
    tab: ROLE_TABS[role].includes(requestedTab ?? "")
      ? (requestedTab as string)
      : defaultTabForRole(role),
    query,
    stage: parseStage(values.stage),
    source: parseSource(values.source),
    assignmentUserId: firstValue(values.assignmentUserId) ?? null,
    sort:
      requestedSort === "updated_desc" || requestedSort === "updated_asc"
        ? requestedSort
        : "default",
  } satisfies WorkInboxFilters;
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

function matchesQuery(query: string, row: WorkInboxRow) {
  if (!query) {
    return true;
  }

  const needle = query.toLowerCase();
  return row.title.toLowerCase().includes(needle) || row.recordingId.toLowerCase().includes(needle);
}

function matchesTab(role: UserRole, tabId: string, row: WorkInboxRow) {
  if (role === "admin" && tabId === "all") {
    return true;
  }

  if (role === "uploader" && tabId === "my-uploads") {
    return true;
  }

  return row.tabId === tabId;
}

function buildHref(role: UserRole, filters: WorkInboxFilters, tab: string) {
  const params = new URLSearchParams();
  if (tab !== defaultTabForRole(role)) {
    params.set("tab", tab);
  }
  if (filters.query) {
    params.set("query", filters.query);
  }
  if (filters.stage) {
    params.set("stage", filters.stage);
  }
  if (filters.source) {
    params.set("source", filters.source);
  }
  if (filters.assignmentUserId) {
    params.set("assignmentUserId", filters.assignmentUserId);
  }
  if (filters.sort !== "default") {
    params.set("sort", filters.sort);
  }

  const query = params.toString();
  return query ? `/workspace?${query}` : "/workspace";
}

function sortRows(role: UserRole, sort: WorkInboxFilters["sort"], rows: WorkInboxRow[]) {
  const sorted = [...rows];

  sorted.sort((left, right) => {
    if (sort === "updated_asc") {
      return left.updatedAt.localeCompare(right.updatedAt);
    }

    if (sort === "updated_desc") {
      return right.updatedAt.localeCompare(left.updatedAt);
    }

    if (role === "admin") {
      const severity = ADMIN_STAGE_SEVERITY[left.stage] - ADMIN_STAGE_SEVERITY[right.stage];
      if (severity !== 0) {
        return severity;
      }
    } else if (Number(right.actionable) !== Number(left.actionable)) {
      return Number(right.actionable) - Number(left.actionable);
    }

    return right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title);
  });

  return sorted;
}

function assignmentLabelForAdmin(
  recordingId: string,
  activeAssignmentsByRecordingId: Map<string, ReturnType<typeof listAssignments>>,
) {
  const assignments = activeAssignmentsByRecordingId.get(recordingId) ?? [];
  if (assignments.length === 0) {
    return "Unassigned";
  }

  return assignments
    .map((assignment) => `${assignment.userDisplayName} - ${formatRoleLabel(assignment.userRole)}`)
    .join(", ");
}

function classifyTab(role: UserRole, stage: CasefileWorkflowStage, completed: boolean) {
  if (role === "uploader") {
    if (stage === "approved") {
      return "ready";
    }

    if (
      stage === "needs_ingest_attention" ||
      stage === "changes_requested" ||
      stage === "reopened"
    ) {
      return "needs-attention";
    }

    return "processing";
  }

  if (role === "reviewer") {
    if (completed) {
      return "completed";
    }

    return stage === "draft_review" || stage === "changes_requested" || stage === "reopened"
      ? "to-review"
      : "waiting";
  }

  if (role === "approver") {
    if (completed) {
      return "completed";
    }

    return stage === "pending_approval" ? "to-decide" : "waiting";
  }

  if (stage === "approved") {
    return "approved";
  }
  if (stage === "pending_approval") {
    return "approval";
  }
  if (stage === "draft_review" || stage === "changes_requested" || stage === "reopened") {
    return "review";
  }
  if (stage === "needs_ingest_attention") {
    return "needs-attention";
  }

  return "all";
}

function actionLabel(role: UserRole, stage: CasefileWorkflowStage, completed: boolean) {
  if (role === "uploader") {
    return null;
  }

  // Admin ledger access (captain ruling): oversight rows always link into
  // the casefile regardless of owner; the link is navigation, not work, so
  // the row stays non-actionable.
  if (role === "admin") {
    return "Open casefile";
  }

  if (completed) {
    return "View snapshot";
  }

  if (role === "reviewer") {
    if (stage === "changes_requested" || stage === "reopened") {
      return "Resume review";
    }

    return stage === "draft_review" ? "Open draft" : null;
  }

  return stage === "pending_approval" ? "Open decision" : null;
}

function isActionable(role: UserRole, stage: CasefileWorkflowStage, completed: boolean) {
  if (completed || role === "uploader" || role === "admin") {
    return false;
  }

  if (role === "reviewer") {
    return stage === "draft_review" || stage === "changes_requested" || stage === "reopened";
  }

  return stage === "pending_approval";
}

function createRow(params: {
  role: UserRole;
  recording: Recording;
  revision: TranscriptRevision | null;
  stage: CasefileWorkflowStage;
  assignmentLabel: string;
  assignmentUserIds: string[];
  updatedAt?: string;
  completedRevisionId?: string | null;
  completed?: boolean;
}) {
  const href = buildRecordingHref(params.recording.id, params.completedRevisionId ?? null);
  const rowActionLabel = actionLabel(params.role, params.stage, Boolean(params.completed));

  return {
    recordingId: params.recording.id,
    title: params.recording.title,
    stage: params.stage,
    stageLabel: formatWorkflowStageLabel(params.stage),
    source: params.recording.source,
    sourceLabel: formatRecordingSourceLabel(params.recording.source),
    revisionLabel: formatRevisionLabel(params.revision),
    progressLabel: formatWorkflowStageLabel(params.stage),
    assignmentLabel: params.assignmentLabel,
    updatedAt: params.updatedAt ?? params.recording.updatedAt,
    updatedAtLabel: formatDateTimeUtc(params.updatedAt ?? params.recording.updatedAt),
    updatedAtIso: formatDateTimeIso(params.updatedAt ?? params.recording.updatedAt),
    href,
    actionable: isActionable(params.role, params.stage, Boolean(params.completed)),
    actionLabel: rowActionLabel,
    tabId: classifyTab(params.role, params.stage, Boolean(params.completed)),
    assignmentUserIds: params.assignmentUserIds,
  } satisfies WorkInboxRow;
}

function reviewerOrApproverRows(
  principal: Principal,
  db: AppDatabase,
  recordingMap: Map<string, Recording>,
  revisionMap: Map<string, TranscriptRevision>,
  decisionMap: Map<string, DecisionRows>,
) {
  const assignments = db
    .select()
    .from(recordingAssignments)
    .where(eq(recordingAssignments.userId, principal.userId))
    .orderBy(desc(recordingAssignments.updatedAt))
    .all()
    .map(toRecordingAssignment)
    .filter((assignment) => assignment.status !== "removed");

  return assignments.flatMap((assignment) => {
    const recording = recordingMap.get(assignment.recordingId);
    if (!recording) {
      return [];
    }

    const requestedRevisionId =
      assignment.status === "completed"
        ? assignment.completedRevisionId
        : recording.currentRevisionId;
    const grant = resolveCasefileAccess(principal, recording.id, requestedRevisionId, db);
    if (!grant) {
      return [];
    }

    const revisionId =
      assignment.status === "completed"
        ? assignment.completedRevisionId
        : recording.currentRevisionId;
    const revision = revisionId ? revisionMap.get(revisionId) ?? null : null;
    const stage = deriveStageForSelection(
      recording,
      revision,
      decisionMap.get(recording.id) ?? [],
    );

    return [
      createRow({
        role: principal.role,
        recording,
        revision,
        stage,
        assignmentLabel:
          assignment.status === "completed" ? "Completed snapshot" : "Assigned to you",
        assignmentUserIds: [assignment.userId],
        updatedAt:
          assignment.status === "completed" ? assignment.updatedAt : recording.updatedAt,
        completedRevisionId: assignment.completedRevisionId,
        completed: assignment.status === "completed",
      }),
    ];
  });
}

function uploaderRows(
  principal: Principal,
  db: AppDatabase,
  recordingMap: Map<string, Recording>,
  revisionMap: Map<string, TranscriptRevision>,
  decisionMap: Map<string, DecisionRows>,
) {
  return Array.from(recordingMap.values())
    .filter((recording) => recording.uploadedByUserId === principal.userId)
    .flatMap((recording) => {
      const grant = resolveCasefileAccess(principal, recording.id, recording.currentRevisionId, db);
      if (!grant) {
        return [];
      }

      const revision = recording.currentRevisionId
        ? revisionMap.get(recording.currentRevisionId) ?? null
        : null;
      const stage = deriveStageForSelection(
        recording,
        revision,
        decisionMap.get(recording.id) ?? [],
      );

      return [
        createRow({
          role: principal.role,
          recording,
          revision: null,
          stage,
          assignmentLabel: "Uploaded by you",
          assignmentUserIds: [principal.userId],
        }),
      ];
    });
}

function adminRows(
  principal: Principal,
  db: AppDatabase,
  recordingMap: Map<string, Recording>,
  revisionMap: Map<string, TranscriptRevision>,
  decisionMap: Map<string, DecisionRows>,
) {
  const activeAssignments = listAssignments({ statuses: ["active"] }, db);
  const activeAssignmentsByRecordingId = activeAssignments.reduce<
    Map<string, typeof activeAssignments>
  >((map, assignment) => {
    const existing = map.get(assignment.recordingId) ?? [];
    existing.push(assignment);
    map.set(assignment.recordingId, existing);
    return map;
  }, new Map());

  return Array.from(recordingMap.values()).flatMap((recording) => {
    const grant = resolveCasefileAccess(principal, recording.id, recording.currentRevisionId, db);
    if (!grant) {
      return [];
    }

    const revision = recording.currentRevisionId
      ? revisionMap.get(recording.currentRevisionId) ?? null
      : null;
    const stage = deriveStageForSelection(
      recording,
      revision,
      decisionMap.get(recording.id) ?? [],
    );
    const assignments = activeAssignmentsByRecordingId.get(recording.id) ?? [];

    return [
      createRow({
        role: principal.role,
        recording,
        revision,
        stage,
        assignmentLabel: assignmentLabelForAdmin(recording.id, activeAssignmentsByRecordingId),
        assignmentUserIds: assignments.map((assignment) => assignment.userId),
      }),
    ];
  });
}

export function listWorkInbox(
  principal: Principal,
  values: Record<string, string | string[] | undefined> = {},
  db: AppDatabase = getAppDb(),
): WorkInboxViewModel {
  const filters = parseWorkInboxFilters(values, principal.role);
  const recordingMap = loadRecordingMap(db);
  const revisionMap = loadRevisionMap(db);
  const decisionMap = loadDecisionMap(db);

  const rows =
    principal.role === "uploader"
      ? uploaderRows(principal, db, recordingMap, revisionMap, decisionMap)
      : principal.role === "admin"
        ? adminRows(principal, db, recordingMap, revisionMap, decisionMap)
        : reviewerOrApproverRows(principal, db, recordingMap, revisionMap, decisionMap);

  const filteredRows = rows.filter((row) => {
    if (!matchesQuery(filters.query, row)) {
      return false;
    }
    if (filters.stage && row.stage !== filters.stage) {
      return false;
    }
    if (filters.source && row.source !== filters.source) {
      return false;
    }
    if (filters.assignmentUserId && !row.assignmentUserIds.includes(filters.assignmentUserId)) {
      return false;
    }
    return true;
  });
  const orderedRows = sortRows(principal.role, filters.sort, filteredRows);
  const nextAction = orderedRows.find((row) => row.actionable) ?? null;

  return {
    role: principal.role,
    heading: ROLE_COPY[principal.role].heading,
    responsibility: ROLE_COPY[principal.role].responsibility,
    filters,
    tabs: ROLE_TABS[principal.role].map((tabId) => ({
      id: tabId,
      label: TAB_LABELS[tabId],
      count: orderedRows.filter((row) => matchesTab(principal.role, tabId, row)).length,
      href: buildHref(principal.role, filters, tabId),
      isActive: filters.tab === tabId,
    })),
    rows: orderedRows.filter((row) => matchesTab(principal.role, filters.tab, row)),
    nextAction,
  };
}
