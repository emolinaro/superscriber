import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal, TranscriptRevision } from "@/domain/models";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import {
  listWorkInbox,
  parseWorkInboxFilters,
} from "@/server/work-inbox/service";
import { openAppDatabase, type AppDatabase } from "@/server/db/client";
import { approvals, recordingAssignments, recordings, revisions, workspaces } from "@/server/db/schema";

const FIXED_NOW = "2026-08-01T12:00:00.000Z";

type TestBundle = ReturnType<typeof openAppDatabase>;

const WORK_INBOX_COPY = {
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
} as const;

const baseSegments = [
  {
    id: "seg-1",
    speakerLabel: "Speaker A",
    startMs: 0,
    endMs: 5_000,
    text: "Hello world.",
    confidence: 0.92,
  },
] satisfies TranscriptRevision["segments"];

function insertWorkspace(bundle: TestBundle) {
  bundle.db.insert(workspaces).values({
    id: "workspace-1",
    name: "Test workspace",
    slug: "test-workspace",
    policyProfileId: "strict",
  }).run();
}

async function createPrincipal(
  db: AppDatabase,
  input: { displayName: string; email: string; role: Principal["role"] },
) {
  const user = await createLocalUser(
    {
      ...input,
      password: "correct horse battery staple",
    },
    db,
  );

  return toPrincipal(user);
}

function insertRecording(
  bundle: TestBundle,
  params: {
    recordingId: string;
    title: string;
    source?: "upload" | "record";
    uploadedByUserId: string;
    currentRevisionId?: string | null;
    currentRevisionState?: "draft" | "pending_approval" | "approved";
    approvedRevisionId?: string | null;
    pendingRevisionId?: string | null;
    basedOnRevisionId?: string | null;
    originDecision?: "changes_requested" | "reopened" | null;
    integrityState?: "verified" | "verification_failed";
    transcriptJobState?: "completed" | "running";
    updatedAt: string;
  },
) {
  if (params.currentRevisionId) {
    bundle.db.insert(revisions).values({
      id: params.currentRevisionId,
      recordingId: params.recordingId,
      version: 1,
      state: params.currentRevisionState ?? "draft",
      basedOnRevisionId: params.basedOnRevisionId ?? null,
      createdByRole: "reviewer",
      createdByUserId: null,
      createdAt: params.updatedAt,
      submittedByUserId: null,
      submittedAt:
        params.currentRevisionState === "pending_approval" ? params.updatedAt : null,
      approvedAt: params.currentRevisionState === "approved" ? params.updatedAt : null,
      summary: params.title,
      segmentsJson: JSON.stringify(baseSegments),
    }).run();
  }

  bundle.db.insert(recordings).values({
    id: params.recordingId,
    workspaceId: "workspace-1",
    title: params.title,
    source: params.source ?? "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: `${params.recordingId}.wav`,
    languageHint: "en",
    transcriptModel: null,
    uploadedByRole: "uploader",
    uploadedByUserId: params.uploadedByUserId,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: params.integrityState ?? "verified",
    transcriptJobState: params.transcriptJobState ?? "completed",
    currentRevisionId: params.currentRevisionId ?? null,
    approvedRevisionId: params.approvedRevisionId ?? null,
    pendingRevisionId: params.pendingRevisionId ?? null,
    verificationSummary: "Ready",
    createdAt: params.updatedAt,
    updatedAt: params.updatedAt,
    automationCursor: null,
  }).run();

  if (params.originDecision && params.basedOnRevisionId) {
    bundle.db.insert(approvals).values({
      id: `approval-${params.recordingId}`,
      recordingId: params.recordingId,
      revisionId: params.basedOnRevisionId,
      state: params.originDecision,
      actorRole: "approver",
      actorUserId: null,
      actorDisplayName: null,
      effectiveRole: "approver",
      adminActionSessionId: null,
      createdAt: params.updatedAt,
      note: null,
    }).run();
  }
}

function insertAssignment(
  bundle: TestBundle,
  params: {
    id: string;
    recordingId: string;
    userId: string;
    assignedByUserId: string;
    role: "reviewer" | "approver";
    status: "active" | "completed" | "removed";
    updatedAt: string;
    completedRevisionId?: string | null;
  },
) {
  bundle.db.insert(recordingAssignments).values({
    id: params.id,
    recordingId: params.recordingId,
    userId: params.userId,
    assignedByUserId: params.assignedByUserId,
    assignmentRole: params.role,
    status: params.status,
    isActive: params.status === "active",
    createdAt: params.updatedAt,
    updatedAt: params.updatedAt,
    endedAt: params.status === "active" ? null : params.updatedAt,
    endReason: params.status === "removed" ? "removed_by_admin" : null,
    completedRevisionId: params.completedRevisionId ?? null,
    removedByUserId: params.status === "removed" ? params.assignedByUserId : null,
  }).run();
}

describe("listWorkInbox", () => {
  it.each([
    ["uploader", WORK_INBOX_COPY.uploader],
    ["reviewer", WORK_INBOX_COPY.reviewer],
    ["approver", WORK_INBOX_COPY.approver],
    ["admin", WORK_INBOX_COPY.admin],
  ] as const)("returns role-specific heading and responsibility for %s", async (role, copy) => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const principal = await createPrincipal(bundle.db, {
        displayName: `${role} user`,
        email: `${role}@example.com`,
        role,
      });

      const inbox = listWorkInbox(principal, {}, bundle.db);
      expect(inbox.heading).toBe(copy.heading);
      expect(inbox.responsibility).toBe(copy.responsibility);
    } finally {
      bundle.sqlite.close();
    }
  });

  it.each([
    ["uploader", "my-uploads"],
    ["reviewer", "to-review"],
    ["approver", "to-decide"],
    ["admin", "all"],
  ] as const)("normalizes filters to the default tab for %s", (role, expectedTab) => {
    expect(
      parseWorkInboxFilters(
        {
          tab: ["invalid-tab"],
          query: ["  Alpha  "],
          stage: ["invalid-stage"],
          source: ["invalid-source"],
          assignmentUserId: ["user-1"],
          sort: ["invalid-sort"],
        },
        role,
      ),
    ).toEqual({
      tab: expectedTab,
      query: "Alpha",
      stage: null,
      source: null,
      assignmentUserId: "user-1",
      sort: "default",
    });
  });

  it("labels the approver default tab exactly as To decide", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const approver = await createPrincipal(bundle.db, {
        displayName: "Approver",
        email: "approver@example.com",
        role: "approver",
      });

      const inbox = listWorkInbox(approver, {}, bundle.db);
      expect(inbox.tabs[0]).toMatchObject({ id: "to-decide", label: "To decide" });
    } finally {
      bundle.sqlite.close();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      role: "reviewer" as const,
      waitingStage: "pending_approval" as const,
      waitingRevisionId: "rev-waiting-reviewer",
      waitingTitle: "Waiting reviewer item",
      completedRevisionId: "rev-approved-reviewer",
      completedTitle: "Completed reviewer item",
      completedTabId: "completed",
    },
    {
      role: "approver" as const,
      waitingStage: "draft" as const,
      waitingRevisionId: "rev-waiting-approver",
      waitingTitle: "Waiting approver item",
      completedRevisionId: "rev-approved-approver",
      completedTitle: "Completed approver item",
      completedTabId: "completed",
    },
  ])(
    "returns a completed $role snapshot row without making it the next action",
    async ({
      role,
      waitingStage,
      waitingRevisionId,
      waitingTitle,
      completedRevisionId,
      completedTitle,
      completedTabId,
    }) => {
      const bundle = openAppDatabase(":memory:");
      insertWorkspace(bundle);

      try {
        const uploader = await createPrincipal(bundle.db, {
          displayName: "Uploader",
          email: "uploader@example.com",
          role: "uploader",
        });
        const principal = await createPrincipal(bundle.db, {
          displayName: role === "reviewer" ? "Reviewer" : "Approver",
          email: `${role}@example.com`,
          role,
        });
        const admin = await createPrincipal(bundle.db, {
          displayName: "Admin",
          email: "admin@example.com",
          role: "admin",
        });

        insertRecording(bundle, {
          recordingId: `rec-waiting-${role}`,
          title: waitingTitle,
          uploadedByUserId: uploader.userId,
          currentRevisionId: waitingRevisionId,
          currentRevisionState: waitingStage === "draft" ? "draft" : waitingStage,
          pendingRevisionId: waitingStage === "pending_approval" ? waitingRevisionId : null,
          updatedAt: "2026-08-01T12:02:00.000Z",
        });
        insertAssignment(bundle, {
          id: `assignment-waiting-${role}`,
          recordingId: `rec-waiting-${role}`,
          userId: principal.userId,
          assignedByUserId: admin.userId,
          role,
          status: "active",
          updatedAt: "2026-08-01T12:02:00.000Z",
        });

        insertRecording(bundle, {
          recordingId: `rec-completed-${role}`,
          title: completedTitle,
          uploadedByUserId: uploader.userId,
          currentRevisionId: completedRevisionId,
          currentRevisionState: "approved",
          approvedRevisionId: completedRevisionId,
          updatedAt: "2026-08-01T12:01:00.000Z",
        });
        insertAssignment(bundle, {
          id: `assignment-completed-${role}`,
          recordingId: `rec-completed-${role}`,
          userId: principal.userId,
          assignedByUserId: admin.userId,
          role,
          status: "completed",
          updatedAt: "2026-08-01T12:01:00.000Z",
          completedRevisionId,
        });

        const inbox = listWorkInbox(principal, { tab: completedTabId }, bundle.db);
        expect(inbox.nextAction).toBeNull();

        expect(inbox.rows).toEqual([
          expect.objectContaining({
            recordingId: `rec-completed-${role}`,
            href: `/recordings/rec-completed-${role}?revision=${completedRevisionId}`,
            actionLabel: "View snapshot",
            actionable: false,
          }),
        ]);
      } finally {
        bundle.sqlite.close();
      }
    },
  );

  it("returns exact reviewer tabs, counts, completed links, and excludes removed assignments", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const uploader = await createPrincipal(bundle.db, {
        displayName: "Uploader",
        email: "uploader@example.com",
        role: "uploader",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Reviewer",
        email: "reviewer@example.com",
        role: "reviewer",
      });
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      insertRecording(bundle, {
        recordingId: "REC-SEARCH",
        title: "Alpha dictation",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-draft",
        currentRevisionState: "draft",
        updatedAt: "2026-08-01T12:03:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-draft",
        recordingId: "REC-SEARCH",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: "2026-08-01T12:03:00.000Z",
      });

      insertRecording(bundle, {
        recordingId: "rec-pending",
        title: "Pending reviewer item",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-pending",
        currentRevisionState: "pending_approval",
        pendingRevisionId: "rev-pending",
        updatedAt: "2026-08-01T12:02:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-pending",
        recordingId: "rec-pending",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: "2026-08-01T12:02:00.000Z",
      });

      insertRecording(bundle, {
        recordingId: "rec-approved",
        title: "Completed reviewer item",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-approved",
        currentRevisionState: "approved",
        approvedRevisionId: "rev-approved",
        updatedAt: "2026-08-01T12:01:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-completed",
        recordingId: "rec-approved",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "completed",
        updatedAt: "2026-08-01T12:01:00.000Z",
        completedRevisionId: "rev-approved",
      });

      insertRecording(bundle, {
        recordingId: "rec-removed",
        title: "Removed reviewer item",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-removed",
        currentRevisionState: "draft",
        updatedAt: "2026-08-01T12:00:30.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-removed",
        recordingId: "rec-removed",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "removed",
        updatedAt: "2026-08-01T12:00:30.000Z",
      });

      const completed = listWorkInbox(reviewer, { tab: "completed" }, bundle.db);
      expect(completed.tabs.map((tab) => tab.id)).toEqual([
        "to-review",
        "waiting",
        "completed",
      ]);
      expect(completed.tabs.map((tab) => tab.count)).toEqual([1, 1, 1]);
      expect(completed.rows.map((row) => row.recordingId)).toEqual(["rec-approved"]);
      expect(completed.rows[0]?.href).toBe("/recordings/rec-approved?revision=rev-approved");
      expect(completed.nextAction?.recordingId).toBe("REC-SEARCH");
    } finally {
      bundle.sqlite.close();
    }
  });

  it("parses reviewer filters defensively and matches title or recording id case-insensitively", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const uploader = await createPrincipal(bundle.db, {
        displayName: "Uploader",
        email: "uploader@example.com",
        role: "uploader",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Reviewer",
        email: "reviewer@example.com",
        role: "reviewer",
      });
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      insertRecording(bundle, {
        recordingId: "REC-SEARCH",
        title: "Alpha dictation",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-draft",
        currentRevisionState: "draft",
        updatedAt: "2026-08-01T12:03:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-draft",
        recordingId: "REC-SEARCH",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: "2026-08-01T12:03:00.000Z",
      });

      const byTitle = listWorkInbox(
        reviewer,
        { tab: "bad-tab", sort: "bad-sort", query: ["  ALPHA  "] },
        bundle.db,
      );
      expect(byTitle.filters).toEqual(
        expect.objectContaining({ tab: "to-review", sort: "default", query: "ALPHA" }),
      );
      expect(byTitle.rows.map((row) => row.recordingId)).toEqual(["REC-SEARCH"]);

      const byId = listWorkInbox(reviewer, { query: "rec-search" }, bundle.db);
      expect(byId.rows.map((row) => row.recordingId)).toEqual(["REC-SEARCH"]);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("limits uploaders to owned rows only and keeps nextAction null", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const uploader = await createPrincipal(bundle.db, {
        displayName: "Uploader One",
        email: "uploader-one@example.com",
        role: "uploader",
      });
      const otherUploader = await createPrincipal(bundle.db, {
        displayName: "Uploader Two",
        email: "uploader-two@example.com",
        role: "uploader",
      });

      insertRecording(bundle, {
        recordingId: "rec-owned",
        title: "Owned ready item",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-owned",
        currentRevisionState: "approved",
        approvedRevisionId: "rev-owned",
        updatedAt: "2026-08-01T12:01:00.000Z",
      });
      insertRecording(bundle, {
        recordingId: "rec-other",
        title: "Someone else's item",
        uploadedByUserId: otherUploader.userId,
        currentRevisionId: "rev-other",
        currentRevisionState: "approved",
        approvedRevisionId: "rev-other",
        updatedAt: "2026-08-01T12:02:00.000Z",
      });

      const inbox = listWorkInbox(uploader, {}, bundle.db);
      expect(inbox.tabs.map((tab) => tab.id)).toEqual([
        "my-uploads",
        "needs-attention",
        "processing",
        "ready",
      ]);
      expect(inbox.rows.map((row) => row.recordingId)).toEqual(["rec-owned"]);
      expect(inbox.tabs.find((tab) => tab.id === "ready")?.count).toBe(1);
      expect(inbox.nextAction).toBeNull();
    } finally {
      bundle.sqlite.close();
    }
  });

  it("applies admin severity ordering and server-backed stage, source, and assignment filters", async () => {
    const bundle = openAppDatabase(":memory:");
    insertWorkspace(bundle);

    try {
      const uploader = await createPrincipal(bundle.db, {
        displayName: "Uploader",
        email: "uploader@example.com",
        role: "uploader",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Reviewer",
        email: "reviewer@example.com",
        role: "reviewer",
      });
      const approver = await createPrincipal(bundle.db, {
        displayName: "Approver",
        email: "approver@example.com",
        role: "approver",
      });
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      insertRecording(bundle, {
        recordingId: "rec-problem",
        title: "Needs ingest attention",
        uploadedByUserId: uploader.userId,
        integrityState: "verification_failed",
        transcriptJobState: "completed",
        updatedAt: "2026-08-01T12:04:00.000Z",
      });
      insertRecording(bundle, {
        recordingId: "rec-review",
        title: "Review item",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-review",
        currentRevisionState: "draft",
        updatedAt: "2026-08-01T12:03:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-review",
        recordingId: "rec-review",
        userId: reviewer.userId,
        assignedByUserId: admin.userId,
        role: "reviewer",
        status: "active",
        updatedAt: "2026-08-01T12:03:00.000Z",
      });

      insertRecording(bundle, {
        recordingId: "rec-approval",
        title: "Approval item",
        uploadedByUserId: uploader.userId,
        source: "record",
        currentRevisionId: "rev-approval",
        currentRevisionState: "pending_approval",
        pendingRevisionId: "rev-approval",
        updatedAt: "2026-08-01T12:02:00.000Z",
      });
      insertAssignment(bundle, {
        id: "assignment-approval",
        recordingId: "rec-approval",
        userId: approver.userId,
        assignedByUserId: admin.userId,
        role: "approver",
        status: "active",
        updatedAt: "2026-08-01T12:02:00.000Z",
      });

      insertRecording(bundle, {
        recordingId: "rec-approved",
        title: "Approved item",
        uploadedByUserId: uploader.userId,
        currentRevisionId: "rev-approved",
        currentRevisionState: "approved",
        approvedRevisionId: "rev-approved",
        updatedAt: "2026-08-01T12:01:00.000Z",
      });

      const adminInbox = listWorkInbox(admin, {}, bundle.db);
      expect(adminInbox.tabs.map((tab) => tab.id)).toEqual([
        "all",
        "needs-attention",
        "review",
        "approval",
        "approved",
      ]);
      expect(adminInbox.rows[0]?.recordingId).toBe("rec-problem");
      expect(adminInbox.rows.at(-1)?.recordingId).toBe("rec-approved");

      const filtered = listWorkInbox(
        admin,
        {
          stage: "pending_approval",
          source: "record",
          assignmentUserId: approver.userId,
        },
        bundle.db,
      );
      expect(filtered.rows.map((row) => row.recordingId)).toEqual(["rec-approval"]);
    } finally {
      bundle.sqlite.close();
    }
  });
});
