import { evaluatePolicy } from "@/domain/policy";
import type {
  AdminActionSession,
  PolicyProfileId,
  Principal,
  Recording,
  TranscriptRevision,
} from "@/domain/models";
import type { CasefileAccessGrant } from "@/server/access/service";

export type CapabilityFlags = {
  canViewStatus: boolean;
  canViewTranscript: boolean;
  canViewMedia: boolean;
  canEdit: boolean;
  canSave: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canReopen: boolean;
  canExport: boolean;
};

export type CapabilityKey = keyof CapabilityFlags;
export type CapabilityDenial =
  | "uploader_status_only"
  | "historical_snapshot"
  | "admin_action_mode_expired"
  | "admin_action_mode_required"
  | "legacy_submitter_unknown"
  | "same_submitter"
  | "not_submitter"
  | "policy"
  | "wrong_revision_state"
  | "not_assigned";

export type CapabilityDenials = Record<CapabilityKey, CapabilityDenial | null>;

export type CasefileCapabilities = CapabilityFlags & {
  denials: CapabilityDenials;
};

export type DeriveCasefileCapabilitiesInput = {
  principal: Principal;
  grant: CasefileAccessGrant;
  policyProfileId: PolicyProfileId;
  recording: Recording;
  revision: TranscriptRevision | null;
  actionMode?: Pick<AdminActionSession, "id" | "effectiveRole"> | null;
  actionModeExpired?: boolean;
};

function isHistoricalSnapshot(input: DeriveCasefileCapabilitiesInput) {
  return Boolean(
    input.revision &&
      input.recording.currentRevisionId &&
      input.revision.id !== input.recording.currentRevisionId,
  );
}

function isCurrentSnapshot(input: DeriveCasefileCapabilitiesInput) {
  return Boolean(
    input.revision && input.recording.currentRevisionId === input.revision.id,
  );
}

function hasUploaderStatusOnly(input: DeriveCasefileCapabilitiesInput) {
  return input.grant.kind === "uploader_status";
}

function hasMatchingOversightGrant(input: DeriveCasefileCapabilitiesInput) {
  return input.grant.kind === "admin_oversight" && input.grant.recordingId === input.recording.id;
}

function hasExpiredAdminActionMode(input: DeriveCasefileCapabilitiesInput) {
  return Boolean(
    input.actionModeExpired &&
      input.principal.role === "admin" &&
      hasMatchingOversightGrant(input),
  );
}

function getValidatedActionMode(input: DeriveCasefileCapabilitiesInput) {
  if (
    !input.actionMode ||
    hasExpiredAdminActionMode(input) ||
    input.principal.role !== "admin" ||
    !hasMatchingOversightGrant(input)
  ) {
    return null;
  }

  return input.actionMode;
}

function isAdminOversight(
  input: DeriveCasefileCapabilitiesInput,
  actionMode: Pick<AdminActionSession, "id" | "effectiveRole"> | null,
) {
  return input.principal.role === "admin" && hasMatchingOversightGrant(input) && !actionMode;
}

function hasReviewerAuthority(
  input: DeriveCasefileCapabilitiesInput,
  actorRole: Principal["role"],
  actionMode: Pick<AdminActionSession, "id" | "effectiveRole"> | null,
) {
  if (actionMode) {
    return actorRole === "reviewer";
  }

  return input.grant.kind === "active_reviewer";
}

function hasApproverAuthority(
  input: DeriveCasefileCapabilitiesInput,
  actorRole: Principal["role"],
  actionMode: Pick<AdminActionSession, "id" | "effectiveRole"> | null,
) {
  if (actionMode) {
    return actorRole === "approver";
  }

  return input.grant.kind === "active_approver" || input.grant.kind === "completed_approver";
}

function hasExportAuthority(
  input: DeriveCasefileCapabilitiesInput,
  actionMode: Pick<AdminActionSession, "id" | "effectiveRole"> | null,
) {
  if (actionMode) {
    return true;
  }

  return (
    input.grant.kind === "active_reviewer" ||
    input.grant.kind === "active_approver" ||
    input.grant.kind === "completed_reviewer" ||
    input.grant.kind === "completed_approver"
  );
}

function currentSubmitterId(input: DeriveCasefileCapabilitiesInput) {
  return input.revision?.submittedByUserId ?? null;
}

function isPending(input: DeriveCasefileCapabilitiesInput) {
  return input.recording.pendingRevisionId === input.revision?.id;
}

function isApproved(input: DeriveCasefileCapabilitiesInput) {
  return input.recording.approvedRevisionId === input.revision?.id;
}

function deriveCapabilityDenials(
  input: DeriveCasefileCapabilitiesInput,
  flags: CapabilityFlags,
): CapabilityDenials {
  const actionMode = getValidatedActionMode(input);
  const actorRole = actionMode?.effectiveRole ?? input.principal.role;
  const policy = evaluatePolicy(input.policyProfileId, actorRole);
  const historical = isHistoricalSnapshot(input);
  const current = isCurrentSnapshot(input);
  const uploaderOnly = hasUploaderStatusOnly(input);
  const adminOversight = isAdminOversight(input, actionMode);
  const reviewerAuthority = hasReviewerAuthority(input, actorRole, actionMode);
  const approverAuthority = hasApproverAuthority(input, actorRole, actionMode);
  const exportAuthority = hasExportAuthority(input, actionMode);
  const pending = isPending(input);
  const approved = isApproved(input);
  const submitterId = currentSubmitterId(input);
  const isSubmitter = submitterId === input.principal.userId;

  function adminActionModeDenial(key: CapabilityKey) {
    if (
      key === "canViewStatus" ||
      key === "canViewTranscript" ||
      key === "canViewMedia"
    ) {
      return null;
    }

    if (hasExpiredAdminActionMode(input)) {
      return "admin_action_mode_expired" satisfies CapabilityDenial;
    }

    if (adminOversight) {
      return "admin_action_mode_required" satisfies CapabilityDenial;
    }

    return null;
  }

  function policyDenied(key: CapabilityKey) {
    if (key === "canViewMedia" && !policy.canViewMedia) {
      return true;
    }
    if ((key === "canEdit" || key === "canSave") && !policy.canEditDraft) {
      return true;
    }
    if (key === "canSubmit" && !policy.canSubmitForApproval) {
      return true;
    }
    if ((key === "canApprove" || key === "canRequestChanges") && !policy.canApprove) {
      return true;
    }
    if (key === "canReopen" && !policy.canReopenApprovedTranscript) {
      return true;
    }
    if (key === "canExport" && !policy.canDownloadApprovedTranscript) {
      return true;
    }

    return false;
  }

  function wrongState(key: CapabilityKey) {
    if (key === "canViewTranscript") {
      return !input.revision;
    }
    if (key === "canEdit" || key === "canSave" || key === "canSubmit") {
      return !current || input.revision?.state !== "draft";
    }
    if (key === "canWithdraw") {
      return !current || !pending;
    }
    if (key === "canApprove" || key === "canRequestChanges") {
      return !current || !pending;
    }
    if (key === "canReopen") {
      return !current || !approved;
    }
    if (key === "canExport") {
      return !current || !approved;
    }

    return false;
  }

  function notAssigned(key: CapabilityKey) {
    if (key === "canEdit" || key === "canSave" || key === "canSubmit" || key === "canWithdraw") {
      return !reviewerAuthority;
    }
    if (key === "canApprove" || key === "canRequestChanges" || key === "canReopen") {
      return !approverAuthority;
    }
    if (key === "canExport") {
      return !exportAuthority;
    }

    return false;
  }

  function denialFor(key: CapabilityKey): CapabilityDenial | null {
    if (flags[key]) {
      return null;
    }

    if (uploaderOnly && key !== "canViewStatus") {
      return "uploader_status_only";
    }

    if (
      historical &&
      key !== "canViewStatus" &&
      key !== "canViewTranscript" &&
      key !== "canViewMedia"
    ) {
      return "historical_snapshot";
    }

    const adminActionMode = adminActionModeDenial(key);
    if (adminActionMode) {
      return adminActionMode;
    }

    if (submitterId === null && current && pending) {
      if (key === "canWithdraw") {
        return "legacy_submitter_unknown";
      }

      if ((key === "canApprove" || key === "canRequestChanges") && approverAuthority) {
        return "legacy_submitter_unknown";
      }
    }

    if (
      isSubmitter &&
      current &&
      pending &&
      approverAuthority &&
      (key === "canApprove" || key === "canRequestChanges")
    ) {
      return "same_submitter";
    }

    if (key === "canWithdraw" && current && pending && submitterId !== null && !isSubmitter) {
      return "not_submitter";
    }

    if (policyDenied(key)) {
      return "policy";
    }

    if (wrongState(key)) {
      return "wrong_revision_state";
    }

    if (notAssigned(key)) {
      return "not_assigned";
    }

    return null;
  }

  return {
    canViewStatus: denialFor("canViewStatus"),
    canViewTranscript: denialFor("canViewTranscript"),
    canViewMedia: denialFor("canViewMedia"),
    canEdit: denialFor("canEdit"),
    canSave: denialFor("canSave"),
    canSubmit: denialFor("canSubmit"),
    canWithdraw: denialFor("canWithdraw"),
    canApprove: denialFor("canApprove"),
    canRequestChanges: denialFor("canRequestChanges"),
    canReopen: denialFor("canReopen"),
    canExport: denialFor("canExport"),
  };
}

export function deriveCasefileCapabilities(
  input: DeriveCasefileCapabilitiesInput,
): CasefileCapabilities {
  const actionMode = getValidatedActionMode(input);
  const actorRole = actionMode?.effectiveRole ?? input.principal.role;
  const policy = evaluatePolicy(input.policyProfileId, actorRole);
  const current = isCurrentSnapshot(input);
  const reviewerAuthority = hasReviewerAuthority(input, actorRole, actionMode);
  const approverAuthority = hasApproverAuthority(input, actorRole, actionMode);
  const exportAuthority = hasExportAuthority(input, actionMode);
  const submitterId = currentSubmitterId(input);
  const isSubmitter = submitterId === input.principal.userId;
  // Captain ruling 2026-08-06: the self-approval veto binds non-admin roles
  // only; administrators may decide revisions they submitted (attribution is
  // carried on the decision row via actor + action-mode session).
  const selfApprovalVetoed = isSubmitter && input.principal.role !== "admin";
  const adminOversight = isAdminOversight(input, actionMode);
  const pending = isPending(input);
  const approved = isApproved(input);

  const flags: CapabilityFlags = {
    canViewStatus: true,
    canViewTranscript: input.grant.kind !== "uploader_status" && Boolean(input.revision),
    canViewMedia: input.grant.kind !== "uploader_status" && policy.canViewMedia,
    canEdit:
      !adminOversight &&
      reviewerAuthority &&
      current &&
      input.revision?.state === "draft" &&
      policy.canEditDraft,
    canSave:
      !adminOversight &&
      reviewerAuthority &&
      current &&
      input.revision?.state === "draft" &&
      policy.canEditDraft,
    canSubmit:
      !adminOversight &&
      reviewerAuthority &&
      current &&
      input.revision?.state === "draft" &&
      policy.canSubmitForApproval,
    canWithdraw:
      !adminOversight &&
      reviewerAuthority &&
      current &&
      pending &&
      submitterId !== null &&
      isSubmitter,
    canApprove:
      !adminOversight &&
      approverAuthority &&
      current &&
      pending &&
      submitterId !== null &&
      !selfApprovalVetoed &&
      policy.canApprove,
    canRequestChanges:
      !adminOversight &&
      approverAuthority &&
      current &&
      pending &&
      submitterId !== null &&
      !selfApprovalVetoed &&
      policy.canApprove,
    canReopen:
      !adminOversight &&
      approverAuthority &&
      current &&
      approved &&
      policy.canReopenApprovedTranscript,
    canExport:
      !adminOversight &&
      exportAuthority &&
      current &&
      approved &&
      policy.canDownloadApprovedTranscript,
  };

  return {
    ...flags,
    denials: deriveCapabilityDenials(input, flags),
  };
}
