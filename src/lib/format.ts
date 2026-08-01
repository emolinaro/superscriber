import {
  ApprovalState,
  IntegrityState,
  TranscriptJobState,
  UserRole,
  WorkspaceBucket,
} from "@/domain/models";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function formatRoleLabel(role: UserRole | "system") {
  if (role === "system") {
    return "System";
  }

  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function formatDateTimeUtc(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value)).replace(", UTC", " UTC");
}

export function formatDateTimeIso(value: string) {
  return new Date(value).toISOString();
}

export function formatDateTime(value: string) {
  return formatDateTimeUtc(value);
}

export function formatSegmentWindow(startMs: number, endMs: number) {
  const startSeconds = Math.floor(startMs / 1000);
  const endSeconds = Math.floor(endMs / 1000);

  const startMinutes = Math.floor(startSeconds / 60);
  const endMinutes = Math.floor(endSeconds / 60);
  const remainingStart = startSeconds % 60;
  const remainingEnd = endSeconds % 60;

  return `${pad(startMinutes)}:${pad(remainingStart)}-${pad(endMinutes)}:${pad(remainingEnd)}`;
}

export function toneForBucket(bucket: WorkspaceBucket) {
  if (bucket === "approved") {
    return "ok";
  }
  if (bucket === "pending_approval" || bucket === "verifying") {
    return "warn";
  }
  if (bucket === "needs_review") {
    return "info";
  }

  return "danger";
}

export function toneForIntegrityState(state: IntegrityState) {
  if (state === "verified") {
    return "ok";
  }
  if (state === "verifying") {
    return "warn";
  }
  return "danger";
}

export function toneForJobState(state: TranscriptJobState) {
  if (state === "completed") {
    return "ok";
  }
  if (state === "running" || state === "queued" || state === "partial_result") {
    return "info";
  }
  return "danger";
}

export function toneForApprovalState(state: ApprovalState) {
  if (state === "approved") {
    return "ok";
  }
  if (state === "pending") {
    return "warn";
  }
  return "info";
}
