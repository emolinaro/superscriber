import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { enterActionMode } from "@/server/casefile/action-mode";
import { actorContextForPrincipal } from "@/server/casefile/audit";
import { resetAppDatabaseForTests, getAppDbBundle } from "@/server/db/client";
import { auditEvents, recordings, revisions, workspaces } from "@/server/db/schema";
import { serializeSegments } from "@/server/db/mappers";
import {
  assignRecordingToUser,
  completeActiveAssignmentsForApproval,
  resolveCasefileAccess,
} from "@/server/access/service";

const { getActivePrincipalMock, buildApprovedTranscriptExportMock } = vi.hoisted(() => ({
  getActivePrincipalMock: vi.fn(),
  buildApprovedTranscriptExportMock: vi.fn(),
}));

vi.mock("@/server/session", () => ({
  getActivePrincipal: getActivePrincipalMock,
}));

vi.mock("@/server/transcript-export", () => ({
  buildApprovedTranscriptExport: buildApprovedTranscriptExportMock,
}));

import { GET } from "./route";

const baseSegments = [
  {
    id: "seg-1",
    speakerLabel: "Speaker 1",
    startMs: 0,
    endMs: 1000,
    text: "Approved transcript segment.",
    confidence: 0.98,
  },
];

function insertApprovedFixture() {
  const bundle = getAppDbBundle();

  bundle.db.insert(workspaces).values({
    id: "workspace-1",
    name: "Test workspace",
    slug: "test-workspace",
    policyProfileId: "strict",
  }).run();

  bundle.db.insert(revisions).values({
    id: "rev-approved",
    recordingId: "rec-1",
    version: 3,
    state: "approved",
    basedOnRevisionId: "rev-2",
    createdByRole: "approver",
    createdByUserId: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    submittedByUserId: null,
    submittedAt: "2026-08-01T12:05:00.000Z",
    approvedAt: "2026-08-01T12:10:00.000Z",
    summary: "Approved transcript.",
    segmentsJson: serializeSegments(baseSegments),
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
    currentRevisionId: "rev-approved",
    approvedRevisionId: "rev-approved",
    pendingRevisionId: null,
    verificationSummary: "Ready for export.",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:10:00.000Z",
    automationCursor: null,
  }).run();

  return bundle;
}

async function createPrincipal(input: {
  displayName: string;
  email: string;
  role: "admin" | "reviewer" | "approver" | "uploader";
}) {
  const bundle = getAppDbBundle();
  return toPrincipal(
    await createLocalUser(
      {
        ...input,
        password: "correct horse battery staple",
      },
      bundle.db,
    ),
  );
}

function exportAuditRows() {
  const bundle = getAppDbBundle();
  return bundle.db.select().from(auditEvents)
    .where(eq(auditEvents.type, "export.issued" as never))
    .all();
}

function insertActionableFixture(input: {
  recordingId: string;
  revisionId: string;
  title: string;
}) {
  const bundle = getAppDbBundle();

  bundle.db.insert(revisions).values({
    id: input.revisionId,
    recordingId: input.recordingId,
    version: 1,
    state: "pending_approval",
    basedOnRevisionId: null,
    createdByRole: "reviewer",
    createdByUserId: null,
    createdAt: "2026-08-01T12:00:00.000Z",
    submittedByUserId: null,
    submittedAt: "2026-08-01T12:05:00.000Z",
    approvedAt: null,
    summary: "Ready for approval.",
    segmentsJson: serializeSegments(baseSegments),
  }).run();

  bundle.db.insert(recordings).values({
    id: input.recordingId,
    workspaceId: "workspace-1",
    title: input.title,
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: `${input.title}.wav`,
    languageHint: "en",
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: null,
    transcriptJobId: null,
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: input.revisionId,
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Ready for approval.",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:05:00.000Z",
    automationCursor: null,
  }).run();
}

describe("GET /api/recordings/[recordingId]/transcript", () => {
  let tempRoot = "";
  const originalDatabasePath = process.env.SUPERSCRIBER_DB_PATH;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAppDatabaseForTests();
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-transcript-route-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "state.db");
    insertApprovedFixture();
    const approver = await createPrincipal({
      displayName: "Approver",
      email: "approver@example.com",
      role: "approver",
    });
    const admin = await createPrincipal({
      displayName: "Admin",
      email: "admin@example.com",
      role: "admin",
    });
    assignRecordingToUser({
      recordingId: "rec-1",
      userId: approver.userId,
      assignedBy: admin,
    }, getAppDbBundle());

    getActivePrincipalMock.mockResolvedValue(approver);
    buildApprovedTranscriptExportMock.mockResolvedValue({
      contentType: "text/plain; charset=utf-8",
      body: new TextEncoder().encode("approved transcript"),
    });
  });

  afterEach(() => {
    resetAppDatabaseForTests();
    rmSync(tempRoot, { recursive: true, force: true });
    process.env.SUPERSCRIBER_DB_PATH = originalDatabasePath;
  });

  it("returns 401 when there is no active session", async () => {
    getActivePrincipalMock.mockResolvedValue(null);

    const response = await GET(
      new Request("https://example.test/api/recordings/rec-1/transcript"),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(response.status).toBe(401);
    expect(exportAuditRows()).toHaveLength(0);
  });

  it("returns 400 for unsupported formats", async () => {
    const response = await GET(
      new Request(
        "https://example.test/api/recordings/rec-1/transcript?format=pdf",
      ),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Unsupported transcript export format.");
    expect(buildApprovedTranscriptExportMock).not.toHaveBeenCalled();
    expect(exportAuditRows()).toHaveLength(0);
  });

  it("requires a valid approver action mode for admin exports", async () => {
    const admin = await createPrincipal({
      displayName: "Admin 2",
      email: "admin2@example.com",
      role: "admin",
    });
    getActivePrincipalMock.mockResolvedValue(admin);

    const missing = await GET(
      new Request("https://example.test/api/recordings/rec-1/transcript?format=txt"),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );
    expect(missing.status).toBe(403);

    const reviewerMode = enterActionMode({
      principal: admin,
      recordingId: "rec-1",
      effectiveRole: "reviewer",
      purpose: "Investigate transcript history before approval.",
    }, getAppDbBundle());

    const wrongRole = await GET(
      new Request(
        `https://example.test/api/recordings/rec-1/transcript?format=txt&actionModeId=${reviewerMode.id}`,
      ),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(wrongRole.status).toBe(403);
    expect(exportAuditRows()).toHaveLength(0);
  });

  it("returns 403 when policy denies transcript export for a reviewer with preserved recording access", async () => {
    const reviewer = await createPrincipal({
      displayName: "Reviewer 2",
      email: "reviewer2@example.com",
      role: "reviewer",
    });
    const admin = await createPrincipal({
      displayName: "Admin 3",
      email: "admin3@example.com",
      role: "admin",
    });
    insertActionableFixture({
      recordingId: "rec-2",
      revisionId: "rev-reviewer-approved",
      title: "Reviewer denied export",
    });
    assignRecordingToUser({
      recordingId: "rec-2",
      userId: reviewer.userId,
      assignedBy: admin,
    }, getAppDbBundle());

    const bundle = getAppDbBundle();
    bundle.db.update(revisions)
      .set({
        state: "approved",
        approvedAt: "2026-08-01T12:10:00.000Z",
        summary: "Approved transcript.",
      })
      .where(eq(revisions.id, "rev-reviewer-approved"))
      .run();
    bundle.db.update(recordings)
      .set({
        approvedRevisionId: "rev-reviewer-approved",
        updatedAt: "2026-08-01T12:10:00.000Z",
        verificationSummary: "Ready for export.",
      })
      .where(eq(recordings.id, "rec-2"))
      .run();
    completeActiveAssignmentsForApproval(
      {
        recordingId: "rec-2",
        revisionId: "rev-reviewer-approved",
        actor: actorContextForPrincipal(admin),
      },
      bundle.db,
      "2026-08-01T12:10:00.000Z",
    );

    expect(
      resolveCasefileAccess(reviewer, "rec-2", "rev-reviewer-approved", bundle.db),
    ).toMatchObject({
      kind: "completed_reviewer",
      recordingId: "rec-2",
      revisionId: "rev-reviewer-approved",
    });

    getActivePrincipalMock.mockResolvedValue(reviewer);

    const response = await GET(
      new Request("https://example.test/api/recordings/rec-2/transcript?format=txt"),
      { params: Promise.resolve({ recordingId: "rec-2" }) },
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(
      "This role cannot export approved transcripts in the current policy profile.",
    );
    expect(buildApprovedTranscriptExportMock).not.toHaveBeenCalled();
    expect(exportAuditRows()).toHaveLength(0);
  });

  it("returns 409 when no approved transcript is active", async () => {
    const bundle = getAppDbBundle();
    bundle.db.update(recordings)
      .set({ approvedRevisionId: null, updatedAt: "2026-08-01T12:11:00.000Z" })
      .where(eq(recordings.id, "rec-1"))
      .run();

    const response = await GET(
      new Request("https://example.test/api/recordings/rec-1/transcript?format=txt"),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("No approved transcript is available for export.");
    expect(exportAuditRows()).toHaveLength(0);
  });

  it("exports the current active approved revision and audits issuance exactly once", async () => {
    const admin = await createPrincipal({
      displayName: "Admin 4",
      email: "admin4@example.com",
      role: "admin",
    });
    const actionMode = enterActionMode({
      principal: admin,
      recordingId: "rec-1",
      effectiveRole: "approver",
      purpose: "Issue an approved transcript export for audit.",
    }, getAppDbBundle());
    getActivePrincipalMock.mockResolvedValue(admin);

    const response = await GET(
      new Request(
        `https://example.test/api/recordings/rec-1/transcript?format=txt&actionModeId=${actionMode.id}&revisionId=rev-legacy`,
      ),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Recording-1-approved-v3.txt"',
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "approved transcript",
    );
    expect(buildApprovedTranscriptExportMock).toHaveBeenCalledWith({
      format: "txt",
      recording: expect.objectContaining({
        id: "rec-1",
        title: "Recording 1",
      }),
      revision: expect.objectContaining({
        id: "rev-approved",
        version: 3,
        state: "approved",
      }),
    });

    const rows = exportAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordingId: "rec-1",
      actorRole: "admin",
      effectiveRole: "approver",
      adminActionSessionId: actionMode.id,
      type: "export.issued",
    });
    expect(rows[0]?.metadata).toContain('"expectedApprovedRevisionId":"rev-approved"');
    expect(rows[0]?.metadata).toContain('"format":"txt"');
  });

  it("exports any named revision under the same authority, with revision attribution (demo-governance-bringback)", async () => {
    // D-3 contract delta: export no longer means "the active approved record"
    // - any revision id of the casefile is exportable by an export-authorized
    // principal, and the audit event carries the revision identity.
    const bundle = getAppDbBundle();
    bundle.db.insert(revisions).values({
      id: "rev-draft",
      recordingId: "rec-1",
      version: 4,
      state: "draft",
      basedOnRevisionId: "rev-approved",
      createdByRole: "reviewer",
      createdByUserId: null,
      createdAt: "2026-08-01T12:20:00.000Z",
      submittedByUserId: null,
      submittedAt: null,
      approvedAt: null,
      summary: "Draft in flight.",
      segmentsJson: serializeSegments(baseSegments),
    }).run();

    const response = await GET(
      new Request(
        "https://example.test/api/recordings/rec-1/transcript?format=md&revisionId=rev-draft",
      ),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Recording-1-v4.md"',
    );
    expect(buildApprovedTranscriptExportMock).toHaveBeenCalledWith({
      format: "md",
      recording: expect.objectContaining({ id: "rec-1" }),
      revision: expect.objectContaining({
        id: "rev-draft",
        version: 4,
        state: "draft",
      }),
    });

    const rows = exportAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("from revision v4");
    expect(rows[0]?.metadata).toContain('"revisionId":"rev-draft"');
    expect(rows[0]?.metadata).toContain('"revisionVersion":4');
  });

  it("does not audit when byte generation fails", async () => {
    buildApprovedTranscriptExportMock.mockRejectedValue(
      new Error("filesystem read failed for temp export"),
    );

    const response = await GET(
      new Request("https://example.test/api/recordings/rec-1/transcript?format=txt"),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(response.status).toBe(500);
    expect(exportAuditRows()).toHaveLength(0);
  });

  it("does not audit when the approved pointer goes stale after bytes are built", async () => {
    const bundle = getAppDbBundle();
    buildApprovedTranscriptExportMock.mockImplementation(async () => {
      bundle.db.update(recordings)
        .set({ approvedRevisionId: null, updatedAt: "2026-08-01T12:12:00.000Z" })
        .where(eq(recordings.id, "rec-1"))
        .run();

      return {
        contentType: "text/plain; charset=utf-8",
        body: new TextEncoder().encode("approved transcript"),
      };
    });

    const response = await GET(
      new Request("https://example.test/api/recordings/rec-1/transcript?format=txt"),
      { params: Promise.resolve({ recordingId: "rec-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("No approved transcript is available for export.");
    expect(exportAuditRows()).toHaveLength(0);
  });
});
