import type { IntegrityState, TranscriptJobState } from "@/domain/models";
import { CasefileCommandError } from "@/server/casefile/errors";

export const CASEFILE_WORKFLOW_STAGES = [
  "needs_ingest_attention",
  "verifying",
  "transcribing",
  "pending_approval",
  "approved",
  "changes_requested",
  "reopened",
  "draft_review",
] as const;

export type CasefileWorkflowStage = (typeof CASEFILE_WORKFLOW_STAGES)[number];
export type WorkflowOriginDecision = "changes_requested" | "reopened" | null;

export type WorkflowStageInput = {
  integrityState: IntegrityState;
  transcriptJobState: TranscriptJobState;
  pendingRevisionId: string | null;
  approvedRevisionId: string | null;
  currentRevisionId: string | null;
  originDecision: WorkflowOriginDecision;
};

export function validateGovernedReason(value: string) {
  const reason = value.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Enter a reason between 10 and 500 characters.",
      {
        reason: "Enter a reason between 10 and 500 characters.",
      },
    );
  }
  return reason;
}

export function validateApprovalNote(value: string) {
  const note = value.trim();
  if (note.length > 500) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Enter a note up to 500 characters.",
      {
        note: "Enter a note up to 500 characters.",
      },
    );
  }
  return note;
}

export function deriveWorkflowStage(input: WorkflowStageInput): CasefileWorkflowStage {
  if (
    input.integrityState === "capturing" ||
    input.integrityState === "uploading" ||
    input.integrityState === "interrupted" ||
    input.integrityState === "verification_failed" ||
    input.transcriptJobState === "failed" ||
    input.transcriptJobState === "cancelled"
  ) {
    return "needs_ingest_attention";
  }

  if (input.integrityState === "verifying") {
    return "verifying";
  }

  if (
    input.transcriptJobState === "queued" ||
    input.transcriptJobState === "running" ||
    input.transcriptJobState === "partial_result"
  ) {
    return "transcribing";
  }

  if (input.pendingRevisionId) {
    return "pending_approval";
  }

  if (input.approvedRevisionId && input.currentRevisionId === input.approvedRevisionId) {
    return "approved";
  }

  if (input.originDecision === "changes_requested") {
    return "changes_requested";
  }

  if (input.originDecision === "reopened") {
    return "reopened";
  }

  return "draft_review";
}
