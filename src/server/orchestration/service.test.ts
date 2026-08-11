import { describe, expect, it } from "vitest";
import { AppState, PolicyProfile, Recording, Workspace } from "@/domain/models";
import { createRecordingEntry } from "@/domain/workflow";
import {
  applyOrchestrationWebhookUpdate,
  normalizeState,
  synchronizeOrchestration,
} from "@/server/orchestration/service";

function nowIso() {
  return new Date().toISOString();
}

function createBaseState(): AppState {
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

  return {
    workspaces: [workspace],
    policyProfiles: policies,
    recordings: [],
    ingestionSessions: [],
    transcriptJobs: [],
    revisions: [],
    approvals: [],
    auditEvents: [],
  };
}

describe("orchestration service", () => {
  it("progresses a new recording through verification, transcription, and draft creation", () => {
    const state = createBaseState();

    createRecordingEntry({
      state,
      workspaceId: state.workspaces[0].id,
      title: "Queued recording",
      source: "record",
      mediaKind: "audio",
      mimeType: "audio/webm",
      mediaPath: "/tmp/queued.webm",
      originalFileName: "queued.webm",
      languageHint: "english",
      transcriptModel: null,
      role: "uploader",
    });

    const createdAtMs = Date.parse(state.recordings[0].createdAt);
    synchronizeOrchestration(state, { nowMs: createdAtMs + 2_000 });
    synchronizeOrchestration(state, { nowMs: createdAtMs + 5_000 });

    expect(state.recordings[0].integrityState).toBe("verified");
    expect(state.recordings[0].transcriptJobState).toBe("completed");
    expect(state.recordings[0].currentRevisionId).not.toBeNull();
    expect(
      state.revisions.filter(
        (revision) => revision.recordingId === state.recordings[0].id,
      ),
    ).toHaveLength(1);
  });

  it("bootstraps legacy recordings into canonical sessions and jobs", () => {
    const state = createBaseState();
    const recording: Recording = {
      id: "legacy-recording",
      workspaceId: state.workspaces[0].id,
      title: "Legacy recording",
      source: "upload",
      mediaKind: "audio",
      mimeType: "audio/wav",
      mediaPath: null,
      originalFileName: "legacy.wav",
      languageHint: "english",
      transcriptModel: null,
      uploadedByRole: "uploader",
      uploadedByUserId: null,
      ingestionSessionId: null,
      transcriptJobId: null,
      integrityState: "verified",
      transcriptJobState: "running",
      currentRevisionId: null,
      approvedRevisionId: null,
      pendingRevisionId: null,
      verificationSummary: "Legacy verified state.",
      createdAt: nowIso(),
      updatedAt: new Date(Date.now() - 4_000).toISOString(),
      automationCursor: null,
    };

    state.recordings.push(recording);
    normalizeState(state);

    expect(state.ingestionSessions).toHaveLength(1);
    expect(state.transcriptJobs).toHaveLength(1);
    expect(state.recordings[0].ingestionSessionId).toBeTruthy();
    expect(state.recordings[0].transcriptJobId).toBeTruthy();
  });

  it("surfaces partial-result state for mixed-language or video jobs before completion", () => {
    const state = createBaseState();

    createRecordingEntry({
      state,
      workspaceId: state.workspaces[0].id,
      title: "Mixed interview",
      source: "upload",
      mediaKind: "video",
      mimeType: "video/mp4",
      mediaPath: "/tmp/mixed.mp4",
      originalFileName: "mixed.mp4",
      languageHint: "mixed",
      transcriptModel: null,
      role: "uploader",
    });

    const createdAtMs = Date.parse(state.recordings[0].createdAt);
    synchronizeOrchestration(state, { nowMs: createdAtMs + 2_000 });
    synchronizeOrchestration(state, { nowMs: createdAtMs + 4_000 });

    expect(state.recordings[0].transcriptJobState).toBe("partial_result");
    expect(state.transcriptJobs[0].diarizationStatus).toBe("degraded");
  });

  it("accepts external webhook updates and materializes a first draft on completion", () => {
    const state = createBaseState();

    createRecordingEntry({
      state,
      workspaceId: state.workspaces[0].id,
      title: "Webhook recording",
      source: "upload",
      mediaKind: "audio",
      mimeType: "audio/wav",
      mediaPath: "/tmp/webhook.wav",
      originalFileName: "webhook.wav",
      languageHint: "english",
      transcriptModel: null,
      role: "uploader",
      adapterId: "external-webhook-engine",
    });

    applyOrchestrationWebhookUpdate(state, {
      recordingId: state.recordings[0].id,
      ingestionSession: {
        state: "verified",
        verificationSummary: "Verified by external engine.",
      },
      transcriptJob: {
        state: "completed",
        progressPercent: 100,
        etaSeconds: 0,
        diarizationStatus: "available",
        summary: "Transcript completed by external engine.",
      },
      transcript: {
        summary: "External engine first draft.",
        segments: [
          {
            id: "ext-1",
            speakerLabel: "Speaker A",
            startMs: 0,
            endMs: 2_000,
            text: "Webhook transcript segment.",
            confidence: 0.97,
          },
        ],
      },
    });

    expect(state.recordings[0].integrityState).toBe("verified");
    expect(state.recordings[0].transcriptJobState).toBe("completed");
    expect(state.recordings[0].currentRevisionId).toBeTruthy();
    expect(state.revisions.at(-1)?.summary).toBe("External engine first draft.");
  });
});
