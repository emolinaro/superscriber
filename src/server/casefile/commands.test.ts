import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Principal, TranscriptRevision } from "@/domain/models";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { assignRecordingToUser } from "@/server/access/service";
import { enterActionMode } from "@/server/casefile/action-mode";
import { saveDraftCommand, submitRevisionCommand } from "@/server/casefile/commands";
import { openAppDatabase } from "@/server/db/client";
import { toRevision } from "@/server/db/mappers";
import {
  adminActionSessions,
  approvals,
  auditEvents,
  recordings,
  revisions,
  workspaces,
  appStateMeta,
} from "@/server/db/schema";

const FIXED_NOW = "2026-08-01T12:00:00.000Z";

type TestBundle = ReturnType<typeof openAppDatabase>;

type DraftInput = {
  recordingId: string;
  expectedCurrentRevisionId: string;
  summary: string;
  segments: TranscriptRevision["segments"];
  actionModeId?: string | null;
};

const baseSegments = [
  {
    id: "seg-1",
    speakerLabel: "Speaker A",
    startMs: 0,
    endMs: 5_000,
    text: "Hello world.",
    confidence: 0.92,
  },
  {
    id: "seg-2",
    speakerLabel: "Speaker B",
    startMs: 5_000,
    endMs: 9_000,
    text: "Please review this governed transcript.",
    confidence: 0.91,
  },
] satisfies TranscriptRevision["segments"];

function cloneSegments(segments: TranscriptRevision["segments"]) {
  return segments.map((segment) => ({ ...segment }));
}

function insertDraftFixture(bundle: TestBundle) {
  bundle.db.insert(workspaces).values({
    id: "workspace-1",
    name: "Test workspace",
    slug: "test-workspace",
    policyProfileId: "strict",
  }).run();

  bundle.db.insert(revisions).values({
    id: "rev-1",
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
    summary: "Initial draft",
    segmentsJson: JSON.stringify(baseSegments),
  }).run();

  bundle.db.insert(recordings).values({
    id: "rec-1",
    workspaceId: "workspace-1",
    title: "Recording 1",
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: "recording.wav",
    languageHint: "en",
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: "rev-1",
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Ready for review.",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    automationCursor: null,
  }).run();
}

async function createPrincipal(
  bundle: TestBundle,
  input: { displayName: string; email: string; role: Principal["role"] },
) {
  const user = await createLocalUser(
    {
      ...input,
      password: "correct horse battery staple",
    },
    bundle.db,
  );

  return toPrincipal(user);
}

async function setupDraftFixture() {
  const bundle = openAppDatabase(":memory:");
  insertDraftFixture(bundle);
  const reviewer = await createPrincipal(bundle, {
    displayName: "Reviewer",
    email: "reviewer@example.com",
    role: "reviewer",
  });
  const admin = await createPrincipal(bundle, {
    displayName: "Admin",
    email: "admin@example.com",
    role: "admin",
  });

  assignRecordingToUser(
    {
      recordingId: "rec-1",
      userId: reviewer.userId,
      assignedBy: admin,
    },
    bundle,
  );

  const draftInput: DraftInput = {
    recordingId: "rec-1",
    expectedCurrentRevisionId: "rev-1",
    summary: "Updated transcript draft.",
    segments: cloneSegments(baseSegments).map((segment, index) => ({
      ...segment,
      text: `${segment.text} Edited ${index + 1}.`,
    })),
  };

  return { bundle, reviewer, admin, draftInput };
}

function readRecording(bundle: TestBundle) {
  return bundle.db.select().from(recordings).where(eq(recordings.id, "rec-1")).get();
}

function readRevision(bundle: TestBundle, revisionId: string) {
  const row = bundle.db
    .select()
    .from(revisions)
    .where(eq(revisions.id, revisionId))
    .get();

  return row ? toRevision(row) : null;
}

function listApprovalRows(bundle: TestBundle) {
  return bundle.db
    .select()
    .from(approvals)
    .where(eq(approvals.recordingId, "rec-1"))
    .all();
}

function listAuditRows(bundle: TestBundle) {
  return bundle.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.recordingId, "rec-1"))
    .all();
}

function listRevisionAuditRows(bundle: TestBundle) {
  return listAuditRows(bundle).filter((row) => row.type.startsWith("revision."));
}

function getStateVersion(bundle: TestBundle) {
  return bundle.db.select().from(appStateMeta).where(eq(appStateMeta.id, 1)).get()?.stateVersion;
}

describe("casefile draft commands", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("supersedes the prior draft and saves a complete next revision", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      const beforeVersion = getStateVersion(bundle);
      const beforeAuditCount = listRevisionAuditRows(bundle).length;
      const saved = saveDraftCommand(reviewer, draftInput, bundle);

      expect(saved.version).toBe(2);
      expect(saved.state).toBe("draft");
      expect(saved.createdByUserId).toBe(reviewer.userId);
      expect(readRevision(bundle, "rev-1")?.state).toBe("superseded");
      expect(readRecording(bundle)?.currentRevisionId).toBe(saved.id);
      expect(listRevisionAuditRows(bundle)).toHaveLength(beforeAuditCount + 1);
      expect(listRevisionAuditRows(bundle).at(-1)?.type).toBe("revision.saved");
      expect(getStateVersion(bundle)).toBe((beforeVersion ?? 0) + 1);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("atomically saves unsaved content and submits the resulting revision", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      const beforeVersion = getStateVersion(bundle);
      const beforeAuditCount = listRevisionAuditRows(bundle).length;
      const submitted = submitRevisionCommand(reviewer, {
        ...draftInput,
        hasUnsavedChanges: true,
      }, bundle);

      expect(submitted.version).toBe(2);
      expect(submitted.state).toBe("pending_approval");
      expect(submitted.submittedByUserId).toBe(reviewer.userId);
      expect(readRevision(bundle, "rev-1")?.state).toBe("superseded");
      expect(readRecording(bundle)).toEqual(
        expect.objectContaining({
          currentRevisionId: submitted.id,
          pendingRevisionId: submitted.id,
        }),
      );
      expect(listApprovalRows(bundle)).toHaveLength(1);
      expect(listApprovalRows(bundle)[0]).toEqual(
        expect.objectContaining({
          revisionId: submitted.id,
          state: "pending",
          actorUserId: reviewer.userId,
          effectiveRole: "reviewer",
        }),
      );
      expect(listRevisionAuditRows(bundle)).toHaveLength(beforeAuditCount + 1);
      expect(listRevisionAuditRows(bundle).at(-1)?.type).toBe("revision.submitted");
      expect(getStateVersion(bundle)).toBe((beforeVersion ?? 0) + 1);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the loaded revision id is missing", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          expectedCurrentRevisionId: "",
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the client drops part of the complete segment array", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          segments: [draftInput.segments[0]!],
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the replacement draft removes all existing segments", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          segments: [],
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("returns a stale conflict snapshot without mutating the winning draft", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      const saved = saveDraftCommand(reviewer, draftInput, bundle);
      const stateVersion = getStateVersion(bundle);

      expect(() =>
        saveDraftCommand(reviewer, {
          ...draftInput,
          expectedCurrentRevisionId: "rev-1",
          summary: "Stale retry",
        }, bundle),
      ).toThrowError(
        expect.objectContaining({
          code: "STALE_REVISION",
          latest: expect.objectContaining({
            recordingId: "rec-1",
            loadedRevisionId: "rev-1",
            currentRevisionId: saved.id,
            winningStage: "draft_review",
          }),
        }),
      );

      expect(getStateVersion(bundle)).toBe(stateVersion);
      expect(readRecording(bundle)?.currentRevisionId).toBe(saved.id);
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the current revision is already pending approval", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      bundle.db.update(revisions)
        .set({ state: "pending_approval", submittedAt: FIXED_NOW, submittedByUserId: reviewer.userId })
        .where(eq(revisions.id, "rev-1"))
        .run();
      bundle.db.update(recordings)
        .set({ pendingRevisionId: "rev-1" })
        .where(eq(recordings.id, "rec-1"))
        .run();

      expect(() => saveDraftCommand(reviewer, draftInput, bundle)).toThrowError(
        /pending/i,
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects save when the current revision is approved", async () => {
    const { bundle, reviewer, draftInput } = await setupDraftFixture();

    try {
      bundle.db.update(revisions)
        .set({ state: "approved", approvedAt: FIXED_NOW })
        .where(eq(revisions.id, "rev-1"))
        .run();
      bundle.db.update(recordings)
        .set({ approvedRevisionId: "rev-1" })
        .where(eq(recordings.id, "rec-1"))
        .run();

      expect(() => saveDraftCommand(reviewer, draftInput, bundle)).toThrowError(
        /reopened|approved/i,
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("requires an active reviewer assignment for reviewer draft commands", async () => {
    const bundle = openAppDatabase(":memory:");
    insertDraftFixture(bundle);
    const reviewer = await createPrincipal(bundle, {
      displayName: "Reviewer",
      email: "reviewer@example.com",
      role: "reviewer",
    });

    try {
      expect(() =>
        saveDraftCommand(reviewer, {
          recordingId: "rec-1",
          expectedCurrentRevisionId: "rev-1",
          summary: "Updated transcript draft.",
          segments: cloneSegments(baseSegments),
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    } finally {
      bundle.sqlite.close();
    }
  });

  it("requires admin reviewer action mode before saving a draft", async () => {
    const { bundle, admin, draftInput } = await setupDraftFixture();

    try {
      expect(() => saveDraftCommand(admin, draftInput, bundle)).toThrowError(
        expect.objectContaining({ code: "ACTION_MODE_REQUIRED" }),
      );
    } finally {
      bundle.sqlite.close();
    }
  });

  it("rejects expired admin reviewer action mode", async () => {
    const { bundle, admin, draftInput } = await setupDraftFixture();

    try {
      const session = enterActionMode(
        {
          principal: admin,
          recordingId: "rec-1",
          effectiveRole: "reviewer",
          purpose: "Review this governed draft carefully.",
        },
        bundle,
      );

      vi.setSystemTime(new Date("2026-08-01T12:31:00.000Z"));

      expect(() =>
        saveDraftCommand(admin, {
          ...draftInput,
          actionModeId: session.id,
        }, bundle),
      ).toThrowError(expect.objectContaining({ code: "ACTION_MODE_EXPIRED" }));

      expect(
        bundle.db.select().from(adminActionSessions).where(eq(adminActionSessions.id, session.id)).get()
          ?.id,
      ).toBe(session.id);
    } finally {
      bundle.sqlite.close();
    }
  });
});
