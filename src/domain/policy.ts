import { PolicyDecision, PolicyProfileId, UserRole } from "@/domain/models";

export function evaluatePolicy(
  profileId: PolicyProfileId,
  role: UserRole,
): PolicyDecision {
  const base: PolicyDecision = {
    canViewMedia: true,
    canDownloadRawMedia: false,
    canEditDraft: role === "reviewer" || role === "admin",
    canSubmitForApproval: role === "reviewer" || role === "admin",
    canApprove: role === "approver" || role === "admin",
    canDownloadApprovedTranscript: role === "approver" || role === "admin",
    canReopenApprovedTranscript: role === "approver" || role === "admin",
  };

  if (profileId === "reviewable-approved-export") {
    return {
      ...base,
      canDownloadApprovedTranscript:
        role === "reviewer" ||
        role === "approver" ||
        role === "admin",
    };
  }

  return base;
}

export function describePolicyProfile(profileId: PolicyProfileId) {
  if (profileId === "reviewable-approved-export") {
    return "Approved transcripts may be exported by reviewers and approvers. Raw media never leaves the server.";
  }

  return "Strict regulated mode. Raw media stays server-side. Approved transcripts require approver or admin export rights.";
}

