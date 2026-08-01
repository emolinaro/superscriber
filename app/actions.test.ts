import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Principal, TranscriptRevision } from "@/domain/models";
import { assignRecordingToUser } from "@/server/access/service";
import {
  approveRevisionCommand,
  submitRevisionCommand,
} from "@/server/casefile/commands";
import {
  openAppDatabase,
  resetAppDatabaseForTests,
  type AppDatabaseBundle,
} from "@/server/db/client";
import {
  approvals,
  auditEvents,
  recordings,
  revisions,
  workspaces,
} from "@/server/db/schema";
import { createLocalUser, toPrincipal } from "@/server/auth/service";

const FIXTURE_PASSWORD = "correct horse battery staple";

const {
  redirectMock,
  revalidatePathMock,
  requireActivePrincipalMock,
} = vi.hoisted(() => {
  class RedirectError extends Error {
    location: string;

    constructor(location: string) {
      super(`Redirected to ${location}`);
      this.location = location;
    }
  }

  return {
    redirectMock: vi.fn((location: string) => {
      throw new RedirectError(location);
    }),
    revalidatePathMock: vi.fn(),
    requireActivePrincipalMock: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: () => false,
}));

vi.mock("@/server/session", () => ({
  requireActivePrincipal: requireActivePrincipalMock,
}));

import { reopenRevisionAction } from "./actions";

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

function insertDraftFixture(bundle: AppDatabaseBundle) {
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
    createdAt: "2026-08-01T12:00:00.000Z",
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
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    automationCursor: null,
  }).run();
}

async function createPrincipal(
  bundle: AppDatabaseBundle,
  input: { displayName: string; email: string; role: Principal["role"] },
) {
  const user = await createLocalUser(
    {
      ...input,
      password: FIXTURE_PASSWORD,
    },
    bundle.db,
  );

  return toPrincipal(user);
}

async function setupApprovedFixture(databasePath: string) {
  const bundle = openAppDatabase(databasePath);
  insertDraftFixture(bundle);

  const reviewer = await createPrincipal(bundle, {
    displayName: "Reviewer",
    email: "reviewer@example.com",
    role: "reviewer",
  });
  const approver = await createPrincipal(bundle, {
    displayName: "Approver",
    email: "approver@example.com",
    role: "approver",
  });
  const admin = await createPrincipal(bundle, {
    displayName: "Admin",
    email: "admin@example.com",
    role: "admin",
  });

  assignRecordingToUser({
    recordingId: "rec-1",
    userId: reviewer.userId,
    assignedBy: admin,
  }, bundle);
  assignRecordingToUser({
    recordingId: "rec-1",
    userId: approver.userId,
    assignedBy: admin,
  }, bundle);

  const pending = submitRevisionCommand(reviewer, {
    recordingId: "rec-1",
    expectedCurrentRevisionId: "rev-1",
    summary: "Updated transcript draft.",
    segments: cloneSegments(baseSegments),
    hasUnsavedChanges: true,
  }, bundle);

  const approved = approveRevisionCommand(approver, {
    recordingId: "rec-1",
    expectedPendingRevisionId: pending.id,
    note: "Approved before testing legacy reopen.",
  }, bundle);

  return { bundle, approver, approved };
}

describe("reopenRevisionAction", () => {
  let tempRoot = "";
  let databasePath = "";
  let bundle: AppDatabaseBundle | null = null;
  const originalDatabasePath = process.env.SUPERSCRIBER_DB_PATH;

  beforeEach(() => {
    resetAppDatabaseForTests();
    redirectMock.mockClear();
    revalidatePathMock.mockClear();
    requireActivePrincipalMock.mockReset();

    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-actions-"));
    databasePath = join(tempRoot, "state.db");
    process.env.SUPERSCRIBER_DB_PATH = databasePath;
  });

  afterEach(() => {
    bundle?.sqlite.close();
    bundle = null;
    resetAppDatabaseForTests();
    rmSync(tempRoot, { recursive: true, force: true });
    process.env.SUPERSCRIBER_DB_PATH = originalDatabasePath;
  });

  it("rejects an omitted reopen reason without creating decision or audit rows", async () => {
    const fixture = await setupApprovedFixture(databasePath);
    bundle = fixture.bundle;
    requireActivePrincipalMock.mockResolvedValue(fixture.approver);

    const beforeApprovals = bundle.db.select().from(approvals)
      .where(eq(approvals.recordingId, "rec-1"))
      .all();
    const beforeAudits = bundle.db.select().from(auditEvents)
      .where(eq(auditEvents.recordingId, "rec-1"))
      .all();
    const beforeRecording = bundle.db.select().from(recordings)
      .where(eq(recordings.id, "rec-1"))
      .get();

    const formData = new FormData();
    formData.set("recordingId", "rec-1");
    formData.set("approvedRevisionId", fixture.approved.revision.id);

    await expect(reopenRevisionAction(formData)).rejects.toMatchObject({
      location: "/recordings/rec-1?error=Enter+a+reason+between+10+and+500+characters.",
    });

    const afterApprovals = bundle.db.select().from(approvals)
      .where(eq(approvals.recordingId, "rec-1"))
      .all();
    const afterAudits = bundle.db.select().from(auditEvents)
      .where(eq(auditEvents.recordingId, "rec-1"))
      .all();
    const afterRecording = bundle.db.select().from(recordings)
      .where(eq(recordings.id, "rec-1"))
      .get();

    expect(afterApprovals).toEqual(beforeApprovals);
    expect(afterAudits).toEqual(beforeAudits);
    expect(afterRecording).toEqual(beforeRecording);
    expect(afterApprovals.some((row) => row.state === "reopened")).toBe(false);
    expect(afterAudits.some((row) => row.type === "approval.reopened")).toBe(false);
    expect(afterApprovals.some((row) => row.note?.includes("legacy review action") ?? false)).toBe(false);
    expect(afterAudits.some((row) => JSON.stringify(row.metadata).includes("legacy review action"))).toBe(false);
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
