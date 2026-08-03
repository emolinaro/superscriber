import { PolicyDecision, PolicyProfileId, UserRole } from "@/domain/models";

export function evaluatePolicy(
  profileId: PolicyProfileId,
  role: UserRole,
): PolicyDecision {
  const base: PolicyDecision = {
    canViewMedia: role === "reviewer" || role === "approver" || role === "admin",
    canDownloadRawMedia: false,
    canEditDraft: role === "reviewer",
    canSubmitForApproval: role === "reviewer",
    canApprove: role === "approver",
    canDownloadApprovedTranscript: role === "approver",
    canReopenApprovedTranscript: role === "approver",
  };

  if (profileId === "reviewable-approved-export") {
    return {
      ...base,
      canDownloadApprovedTranscript: role === "reviewer" || role === "approver",
    };
  }

  if (role === "admin") {
    return {
      ...base,
      canEditDraft: false,
      canSubmitForApproval: false,
      canApprove: false,
      canDownloadApprovedTranscript: false,
      canReopenApprovedTranscript: false,
    };
  }

  return base;
}

export function describePolicyProfile(profileId: PolicyProfileId) {
  if (profileId === "reviewable-approved-export") {
    return "Approved transcripts may be exported by reviewers and approvers. Raw media never leaves the server.";
  }

  return "Strict regulated mode. Raw media stays server-side. Approved transcripts require approver export rights.";
}
