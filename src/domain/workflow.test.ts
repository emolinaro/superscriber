import { describe, expect, it } from "vitest";
import { AppState, PolicyProfile, Recording, TranscriptRevision, Workspace } from "@/domain/models";
import {
  approveRevision,
  reopenApprovedRevision,
  saveDraftRevision,
  submitRevision,
} from "@/domain/workflow";

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

  const draftRevision: TranscriptRevision = {
    id: "rev-1",
    recordingId: "rec-1",
    version: 1,
    state: "draft",
    basedOnRevisionId: null,
    createdByRole: "system",
    createdAt: nowIso(),
    submittedAt: null,
    approvedAt: null,
    summary: "Initial draft",
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
    ingestionSessionId: "ingest-1",
    transcriptJobId: "job-1",
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: draftRevision.id,
    approvedRevisionId: null,
    pendingRevisionId: null,
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
    revisions: [draftRevision],
    approvals: [],
    auditEvents: [],
  };
}

describe("workflow", () => {
  it("requires an explicit reopen permission before editing an approved transcript", () => {
    const state = createState();

    submitRevision({
      state,
      recordingId: "rec-1",
      role: "reviewer",
      expectedCurrentRevisionId: "rev-1",
    });
    approveRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedPendingRevisionId: state.recordings[0]?.pendingRevisionId ?? "",
    });

    expect(() =>
      saveDraftRevision({
        state,
        recordingId: "rec-1",
        role: "reviewer",
        expectedCurrentRevisionId: state.recordings[0]?.currentRevisionId ?? "",
        summary: "Attempted edit",
        segments: [
          {
            id: "seg-1",
            speakerLabel: "Speaker A",
            startMs: 0,
            endMs: 5_000,
            text: "Changed text.",
            confidence: 0.92,
          },
        ],
      }),
    ).toThrow(/reopened/i);
  });

  it("reopens an approved revision as a new draft cycle", () => {
    const state = createState();

    submitRevision({
      state,
      recordingId: "rec-1",
      role: "reviewer",
      expectedCurrentRevisionId: "rev-1",
    });
    approveRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedPendingRevisionId: state.recordings[0]?.pendingRevisionId ?? "",
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
    expect(recording.pendingRevisionId).toBeNull();
  });

  it("rejects saving from a stale loaded revision", () => {
    const state = createState();

    saveDraftRevision({
      state,
      recordingId: "rec-1",
      role: "reviewer",
      expectedCurrentRevisionId: "rev-1",
      summary: "Fresh draft",
      segments: [
        {
          id: "seg-1",
          speakerLabel: "Speaker A",
          startMs: 0,
          endMs: 5_000,
          text: "Fresh draft text.",
          confidence: 0.92,
        },
      ],
    });

    expect(() =>
      saveDraftRevision({
        state,
        recordingId: "rec-1",
        role: "reviewer",
        expectedCurrentRevisionId: "rev-1",
        summary: "Stale draft",
        segments: [
          {
            id: "seg-1",
            speakerLabel: "Speaker A",
            startMs: 0,
            endMs: 5_000,
            text: "Stale text.",
            confidence: 0.92,
          },
        ],
      }),
    ).toThrow(/newer draft revision/i);
  });

  it("rejects saving an empty draft over an existing transcript", () => {
    const state = createState();

    expect(() =>
      saveDraftRevision({
        state,
        recordingId: "rec-1",
        role: "reviewer",
        expectedCurrentRevisionId: "rev-1",
        summary: "Transcript draft is not ready yet.",
        segments: [],
      }),
    ).toThrow(/missing transcript segments/i);
  });

  it("allocates the next draft version from revision history, not the current pointer", () => {
    const state = createState();

    state.revisions.push({
      id: "rev-2-orphan",
      recordingId: "rec-1",
      version: 2,
      state: "draft",
      basedOnRevisionId: "rev-1",
      createdByRole: "admin",
      createdAt: nowIso(),
      submittedAt: null,
      approvedAt: null,
      summary: "Orphaned draft",
      segments: [],
    });

    const saved = saveDraftRevision({
      state,
      recordingId: "rec-1",
      role: "reviewer",
      expectedCurrentRevisionId: "rev-1",
      summary: "Fresh draft after orphan",
      segments: [
        {
          id: "seg-1",
          speakerLabel: "Speaker A",
          startMs: 0,
          endMs: 5_000,
          text: "Fresh draft text.",
          confidence: 0.92,
        },
      ],
    });

    expect(saved.version).toBe(3);
  });

  it("rejects approving a stale pending revision id", () => {
    const state = createState();

    submitRevision({
      state,
      recordingId: "rec-1",
      role: "reviewer",
      expectedCurrentRevisionId: "rev-1",
    });
    const firstPendingRevisionId = state.recordings[0]?.pendingRevisionId ?? "";

    approveRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedPendingRevisionId: firstPendingRevisionId,
    });
    reopenApprovedRevision({
      state,
      recordingId: "rec-1",
      role: "approver",
      expectedApprovedRevisionId: state.recordings[0]?.approvedRevisionId ?? "",
    });
    const reopenedRevisionId = state.recordings[0]?.currentRevisionId ?? "";
    saveDraftRevision({
      state,
      recordingId: "rec-1",
      role: "reviewer",
      expectedCurrentRevisionId: reopenedRevisionId,
      summary: "Another revision",
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
    submitRevision({
      state,
      recordingId: "rec-1",
      role: "reviewer",
      expectedCurrentRevisionId: state.recordings[0]?.currentRevisionId ?? "",
    });

    expect(() =>
      approveRevision({
        state,
        recordingId: "rec-1",
        role: "approver",
        expectedPendingRevisionId: firstPendingRevisionId,
      }),
    ).toThrow(/different revision is now pending approval/i);
  });
});
