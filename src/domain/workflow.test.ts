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

    submitRevision({ state, recordingId: "rec-1", role: "reviewer" });
    approveRevision({ state, recordingId: "rec-1", role: "approver" });

    expect(() =>
      saveDraftRevision({
        state,
        recordingId: "rec-1",
        role: "reviewer",
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

    submitRevision({ state, recordingId: "rec-1", role: "reviewer" });
    approveRevision({ state, recordingId: "rec-1", role: "approver" });
    reopenApprovedRevision({ state, recordingId: "rec-1", role: "approver" });

    const recording = state.recordings[0];
    const currentRevision = state.revisions.find(
      (revision) => revision.id === recording.currentRevisionId,
    );

    expect(currentRevision?.state).toBe("draft");
    expect(currentRevision?.version).toBe(2);
    expect(recording.pendingRevisionId).toBeNull();
  });
});
