import { describe, expect, it } from "vitest";
import type { Recording } from "@/domain/models";
import { bucketRecording } from "@/domain/workflow";

function buildRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    workspaceId: "workspace-1",
    title: "Interview 1",
    source: "upload",
    mediaKind: "audio",
    mimeType: "audio/wav",
    mediaPath: null,
    originalFileName: "interview.wav",
    languageHint: "english",
    transcriptModel: null,
    uploadedByRole: "uploader",
    uploadedByUserId: null,
    ingestionSessionId: "ingest-1",
    transcriptJobId: "job-1",
    integrityState: "verified",
    transcriptJobState: "completed",
    currentRevisionId: "rev-1",
    approvedRevisionId: null,
    pendingRevisionId: null,
    verificationSummary: "Verified.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    automationCursor: null,
    ...overrides,
  };
}

describe("workflow", () => {
  it("buckets governed recordings by active lifecycle pointers", () => {
    expect(bucketRecording(buildRecording({ pendingRevisionId: "rev-pending" }))).toBe(
      "pending_approval",
    );
    expect(
      bucketRecording(
        buildRecording({ approvedRevisionId: "rev-approved", currentRevisionId: "rev-approved" }),
      ),
    ).toBe("approved");
    expect(bucketRecording(buildRecording())).toBe("needs_review");
  });
});
