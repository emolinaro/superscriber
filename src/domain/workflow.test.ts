import { describe, expect, it } from "vitest";
import { AppState, PolicyProfile, Recording, TranscriptRevision, Workspace } from "@/domain/models";
import { approveRevision, reopenApprovedRevision } from "@/domain/workflow";

function nowIso() {
  return new Date().toISOString();
}

function createState(): AppState {
  const workspace: Workspace = {
    id: "workspace-1",
    name: "Regulated",
    slug: "regulated",
    policyProfileId: "strict",
  };

  const policies: PolicyProfile[] = [
    {
      id: "strict",
      label: "Strict",
      description: "Strict regulated mode.",
    },
  ];

  const pendingRevision: TranscriptRevision = {
    id: "rev-1",
    recordingId: "rec-1",
    version: 1,
    state: "pending_approval",
    basedOnRevisionId: null,
    createdByRole: "reviewer",
    createdByUserId: null,
    createdAt: nowIso(),
    submittedByUserId: null,
    submittedAt: nowIso(),
    approvedAt: null,
    summary: "Pending draft",
    segments: [
      {
        id: "seg-1",
        speakerLabel: "Speaker A",
        startMs: 0,
        endMs: 5_000,
        text: "Hello world.",
        confidence: 0.92,
      },
    ],
  };

  const recording: Recording = {
    id: "rec-1",
    workspaceId: workspace.id,
    title: "Interview 1",
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: "interview.wav",
    languageHint: "english",
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: "ingest-1",
    transcriptJobId: "job-1",
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: pendingRevision.id,
    approvedRevisionId: null,
    pendingRevisionId: pendingRevision.id,
    verificationSummary: "Verified.",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    automationCursor: null,
  };

  return {
    workspaces: [workspace],
    policyProfiles: policies,
    recordings: [recording],
    ingestionSessions: [],
    transcriptJobs: [],
    revisions: [pendingRevision],
    approvals: [],
    auditEvents: [],
  };
}

describe("workflow", () => {
  it("approves the current pending revision and updates the recording pointers", () => {
    const state = createState();

    approveRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedPendingRevisionId: "rev-1",
    });

    const recording = state.recordings[0];
    const approvedRevision = state.revisions.find((revision) => revision.id === "rev-1");

    expect(approvedRevision?.state).toBe("approved");
    expect(recording?.approvedRevisionId).toBe("rev-1");
    expect(recording?.pendingRevisionId).toBeNull();
    expect(recording?.currentRevisionId).toBe("rev-1");
  });

  it("reopens an approved revision as a new draft cycle", () => {
    const state = createState();

    approveRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedPendingRevisionId: "rev-1",
    });
    reopenApprovedRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedApprovedRevisionId: state.recordings[0]?.approvedRevisionId ?? "",
    });

    const recording = state.recordings[0];
    const currentRevision = state.revisions.find(
      (revision) => revision.id === recording.currentRevisionId,
    );

    expect(currentRevision?.state).toBe("draft");
    expect(currentRevision?.version).toBe(2);
    expect(recording?.pendingRevisionId).toBeNull();
  });

  it("rejects approving a stale pending revision id", () => {
    const state = createState();

    approveRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedPendingRevisionId: "rev-1",
    });

    state.revisions.push({
      id: "rev-2",
      recordingId: "rec-1",
      version: 2,
      state: "pending_approval",
      basedOnRevisionId: "rev-1",
      createdByRole: "reviewer",
      createdByUserId: null,
      createdAt: nowIso(),
      submittedByUserId: null,
      submittedAt: nowIso(),
      approvedAt: null,
      summary: "A newer pending revision",
      segments: [
        {
          id: "seg-1",
          speakerLabel: "Speaker A",
          startMs: 0,
          endMs: 5_000,
          text: "Updated after reopen.",
          confidence: 0.92,
        },
      ],
    });
    state.recordings[0]!.currentRevisionId = "rev-2";
    state.recordings[0]!.pendingRevisionId = "rev-2";

    expect(() =>
      approveRevision({
        state,
        recordingId: "rec-1",
        role: "approver",
        expectedPendingRevisionId: "rev-1",
      }),
    ).toThrow(/different revision is now pending approval/i);
  });
});
