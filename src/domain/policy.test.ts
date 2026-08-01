import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@/domain/policy";

describe("evaluatePolicy", () => {
  it("keeps raw media playback out of uploader-only hands", () => {
    expect(evaluatePolicy("strict", "uploader").canViewMedia).toBe(false);
    expect(evaluatePolicy("strict", "reviewer").canViewMedia).toBe(true);
    expect(evaluatePolicy("strict", "approver").canViewMedia).toBe(true);
    expect(evaluatePolicy("strict", "admin").canViewMedia).toBe(true);
  });

  it("blocks raw media download for every role", () => {
    expect(evaluatePolicy("strict", "uploader").canDownloadRawMedia).toBe(false);
    expect(evaluatePolicy("strict", "reviewer").canDownloadRawMedia).toBe(false);
    expect(evaluatePolicy("strict", "approver").canDownloadRawMedia).toBe(false);
  });

  it("allows reviewers to export approved transcripts only in the reviewable profile", () => {
    expect(
      evaluatePolicy("strict", "reviewer").canDownloadApprovedTranscript,
    ).toBe(false);
    expect(
      evaluatePolicy("reviewable-approved-export", "reviewer")
        .canDownloadApprovedTranscript,
    ).toBe(true);
  });

  it("keeps approval authority with approver and action-mode roles only", () => {
    expect(evaluatePolicy("strict", "reviewer").canApprove).toBe(false);
    expect(evaluatePolicy("strict", "approver").canApprove).toBe(true);
    expect(evaluatePolicy("strict", "admin").canApprove).toBe(false);
  });

  it("keeps admin base policy in read-only oversight mode", () => {
    const decision = evaluatePolicy("strict", "admin");

    expect(decision.canViewMedia).toBe(true);
    expect(decision.canEditDraft).toBe(false);
    expect(decision.canSubmitForApproval).toBe(false);
    expect(decision.canApprove).toBe(false);
    expect(decision.canDownloadApprovedTranscript).toBe(false);
    expect(decision.canReopenApprovedTranscript).toBe(false);
  });
});
