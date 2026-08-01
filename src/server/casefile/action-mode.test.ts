import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Principal } from "@/domain/models";
import {
  deriveWorkflowStage,
  validateApprovalNote,
  validateGovernedReason,
  type WorkflowStageInput,
} from "@/domain/casefile";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { openAppDatabase, type AppDatabase } from "@/server/db/client";
import { adminActionSessions, auditEvents, recordings, revisions, workspaces } from "@/server/db/schema";
import {
  enterActionMode,
  exitActionMode,
  resolveActorContext,
} from "@/server/casefile/action-mode";

const FIXED_NOW = "2026-08-01T12:00:00.000Z";

const baseStageInput = {
  integrityState: "verified",
  transcriptJobState: "completed",
  pendingRevisionId: null,
  approvedRevisionId: null,
  currentRevisionId: "rev-draft",
  originDecision: null,
} as const;

type TestBundle = ReturnType<typeof openAppDatabase>;

function createRecordingFixture(bundle: TestBundle) {
  bundle.db.insert(workspaces).values({
    id: "workspace-1",
    name: "Test workspace",
    slug: "test-workspace",
    policyProfileId: "strict",
  }).run();

  bundle.db.insert(revisions).values({
    id: "rev-draft",
    recordingId: "rec-1",
    version: 1,
    state: "draft",
    basedOnRevisionId: null,
    createdByRole: "system",
    createdByUserId: null,
    createdAt: FIXED_NOW,
    submittedByUserId: null,
    submittedAt: null,
    approvedAt: null,
    summary: "Draft",
    segmentsJson: "[]",
  }).run();

  bundle.db.insert(recordings).values({
    id: "rec-1",
    workspaceId: "workspace-1",
    title: "Recording 1",
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: null,
    languageHint: "en",
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: "rev-draft",
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Ready",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    automationCursor: null,
  }).run();

  bundle.db.insert(revisions).values({
    id: "rev-other",
    recordingId: "rec-other",
    version: 1,
    state: "draft",
    basedOnRevisionId: null,
    createdByRole: "system",
    createdByUserId: null,
    createdAt: FIXED_NOW,
    submittedByUserId: null,
    submittedAt: null,
    approvedAt: null,
    summary: "Other draft",
    segmentsJson: "[]",
  }).run();

  bundle.db.insert(recordings).values({
    id: "rec-other",
    workspaceId: "workspace-1",
    title: "Recording 2",
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: null,
    languageHint: "en",
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: "rev-other",
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Ready",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    automationCursor: null,
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

function listActionModeAuditRows(bundle: TestBundle) {
  return bundle.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.recordingId, "rec-1"))
    .all();
}

describe("casefile action mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [{ integrityState: "interrupted" }, "needs_ingest_attention"],
    [{ integrityState: "verifying" }, "verifying"],
    [{ transcriptJobState: "running" }, "transcribing"],
    [{ pendingRevisionId: "rev-pending" }, "pending_approval"],
    [{ approvedRevisionId: "rev-approved", currentRevisionId: "rev-approved" }, "approved"],
    [{ originDecision: "changes_requested" }, "changes_requested"],
    [{ originDecision: "reopened" }, "reopened"],
    [{ currentRevisionId: "rev-draft" }, "draft_review"],
  ] satisfies [Partial<WorkflowStageInput>, ReturnType<typeof deriveWorkflowStage>][]) (
    "derives stage in governing precedence",
    (overrides, expected) => {
      expect(deriveWorkflowStage({ ...baseStageInput, ...overrides })).toBe(expected);
    },
  );

  it("trims governed reasons and approval notes with the required limits", () => {
    expect(validateGovernedReason("  enough reason text  ")).toBe("enough reason text");
    expect(validateApprovalNote("  optional note  ")).toBe("optional note");
    expect(validateApprovalNote("   ")).toBe("");

    expect(() => validateGovernedReason(" too short ")).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => validateGovernedReason("x".repeat(501))).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => validateApprovalNote("x".repeat(501))).toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("enters action mode with a fixed 30 minute expiry and switches any prior active session", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      createRecordingFixture(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      const first = enterActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "reviewer",
          purpose: "  Review a governed draft carefully.  ",
        },
        bundle,
      );

      expect(first.purpose).toBe("Review a governed draft carefully.");
      expect(first.startedAt).toBe(FIXED_NOW);
      expect(first.expiresAt).toBe("2026-08-01T12:30:00.000Z");

      const second = enterActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "approver",
          purpose: "Approve a governed transcript change safely.",
        },
        bundle,
      );

      const sessionRows = bundle.db.select().from(adminActionSessions).all();
      expect(sessionRows).toHaveLength(2);
      expect(sessionRows.filter((row) => row.endedAt === null)).toHaveLength(1);
      expect(sessionRows.find((row) => row.id === first.id)?.endReason).toBe("switched");
      expect(sessionRows.find((row) => row.id === second.id)?.endedAt).toBeNull();

      const auditRows = listActionModeAuditRows(bundle);
      expect(auditRows).toHaveLength(3);
      expect(auditRows.map((row) => row.type)).toEqual([
        "admin.action_mode.entered",
        "admin.action_mode.exited",
        "admin.action_mode.entered",
      ]);
      expect(JSON.parse(auditRows[1]!.metadata)).toEqual({
        version: 1,
        data: {
          actionModeId: first.id,
          effectiveRole: "reviewer",
          endReason: "switched",
        },
      });
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects invalid purpose lengths and non-admin entry", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      createRecordingFixture(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });
      const reviewer = await createPrincipal(bundle.db, {
        displayName: "Reviewer",
        email: "reviewer@example.com",
        role: "reviewer",
      });

      expect(() =>
        enterActionMode(
          {
            principal: admin,
            recordingId: "rec-1",
            effectiveRole: "reviewer",
            purpose: "short",
          },
          bundle,
        ),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

      expect(() =>
        enterActionMode(
          {
            principal: reviewer,
            recordingId: "rec-1",
            effectiveRole: "reviewer",
            purpose: "This purpose is long enough to be rejected for role only.",
          },
          bundle,
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_FORBIDDEN" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("exits action mode explicitly once and rejects reuse of the ended session", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      createRecordingFixture(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      const session = enterActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "reviewer",
          purpose: "Review a governed transcript draft carefully.",
        },
        bundle,
      );

      vi.setSystemTime(new Date("2026-08-01T12:05:00.000Z"));
      const exited = exitActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          actionModeId: session.id,
        },
        bundle,
      );

      expect(exited.endedAt).toBe("2026-08-01T12:05:00.000Z");
      expect(exited.endReason).toBe("exited");

      expect(() =>
        resolveActorContext(
          admin,
          {
            recordingId: "rec-1",
            requiredEffectiveRole: "reviewer",
            actionModeId: session.id,
          },
          bundle.db,
          "2026-08-01T12:05:00.000Z",
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_ENDED" }));

      expect(() =>
        exitActionMode(
          {
            principal: admin,
            recordingId: "rec-1",
            actionModeId: session.id,
          },
          bundle,
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_ENDED" }));

      const exitedAudits = listActionModeAuditRows(bundle).filter(
        (row) => row.type === "admin.action_mode.exited",
      );
      expect(exitedAudits).toHaveLength(1);
      expect(JSON.parse(exitedAudits[0]!.metadata)).toEqual({
        version: 1,
        data: {
          actionModeId: session.id,
          effectiveRole: "reviewer",
          endReason: "exited",
        },
      });
    } finally {
      bundle.sqlite.close();
    }
  });

  it("expires action mode lazily with one audit and stable safe errors", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      createRecordingFixture(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });

      const session = enterActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "approver",
          purpose: "Approve a governed transcript without bypassing policy.",
        },
        bundle,
      );

      expect(() =>
        resolveActorContext(
          admin,
          {
            recordingId: "rec-1",
            requiredEffectiveRole: "approver",
            actionModeId: session.id,
          },
          bundle.db,
          "2026-08-01T12:31:00.000Z",
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_EXPIRED" }));

      expect(() =>
        resolveActorContext(
          admin,
          {
            recordingId: "rec-1",
            requiredEffectiveRole: "approver",
            actionModeId: session.id,
          },
          bundle.db,
          "2026-08-01T12:31:00.000Z",
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_ENDED" }));

      const row = bundle.db
        .select()
        .from(adminActionSessions)
        .where(eq(adminActionSessions.id, session.id))
        .get();
      expect(row?.endReason).toBe("expired");
      expect(row?.endedAt).toBe("2026-08-01T12:31:00.000Z");

      const exitedAudits = listActionModeAuditRows(bundle).filter(
        (entry) => entry.type === "admin.action_mode.exited",
      );
      expect(exitedAudits).toHaveLength(1);
      expect(JSON.parse(exitedAudits[0]!.metadata)).toEqual({
        version: 1,
        data: {
          actionModeId: session.id,
          effectiveRole: "approver",
          endReason: "expired",
        },
      });
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects wrong user, wrong recording, and wrong effective role when resolving actor context", async () => {
    const bundle = openAppDatabase(":memory:");

    try {
      createRecordingFixture(bundle);
      const admin = await createPrincipal(bundle.db, {
        displayName: "Admin",
        email: "admin@example.com",
        role: "admin",
      });
      const otherAdmin = await createPrincipal(bundle.db, {
        displayName: "Other Admin",
        email: "other-admin@example.com",
        role: "admin",
      });

      const session = enterActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "reviewer",
          purpose: "Review a governed transcript draft carefully.",
        },
        bundle,
      );

      expect(() =>
        resolveActorContext(
          otherAdmin,
          {
            recordingId: "rec-1",
            requiredEffectiveRole: "reviewer",
            actionModeId: session.id,
          },
          bundle.db,
          FIXED_NOW,
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_REQUIRED" }));

      expect(() =>
        resolveActorContext(
          admin,
          {
            recordingId: "rec-other",
            requiredEffectiveRole: "approver",
            actionModeId: session.id,
          },
          bundle.db,
          FIXED_NOW,
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_REQUIRED" }));

      expect(() =>
        resolveActorContext(
          admin,
          {
            recordingId: "rec-1",
            requiredEffectiveRole: "approver",
            actionModeId: session.id,
          },
          bundle.db,
          FIXED_NOW,
        ),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_REQUIRED" }));
    } finally {
      bundle.sqlite.close();
    }
  });
});
