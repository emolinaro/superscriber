import type { RecordingSource } from "@/domain/models";

export const CHUNK_SIZE = 1024 * 1024;
export const PENDING_INGEST_KEY = "superscriber.pendingIngest";

export type UploadSessionStatus = {
  sessionId: string;
  recordingId: string;
  state: string;
  integrityState: string;
  bytesReceived: number;
  bytesExpected: number;
  progressPercent: number;
  resumeToken: string | null;
  nextAction: "resume" | "restart" | "finalize" | "none";
  verificationSummary: string | null;
  title: string;
  source: RecordingSource;
  mediaPath: string | null;
  tempFilePresent: boolean;
  warning?: string | null;
};

export type PendingIngest = {
  sessionId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  fileLastModified: number;
  source: RecordingSource;
};

function isPendingIngest(value: unknown): value is PendingIngest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.fileName === "string" &&
    typeof candidate.fileSize === "number" &&
    Number.isFinite(candidate.fileSize) &&
    typeof candidate.fileType === "string" &&
    typeof candidate.fileLastModified === "number" &&
    Number.isFinite(candidate.fileLastModified) &&
    (candidate.source === "upload" || candidate.source === "record")
  );
}

export function readPendingIngest() {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(PENDING_INGEST_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPendingIngest(parsed)) {
      clearPendingIngest();
      return null;
    }

    return parsed;
  } catch {
    clearPendingIngest();
    return null;
  }
}

export function writePendingIngest(value: PendingIngest) {
  window.localStorage.setItem(PENDING_INGEST_KEY, JSON.stringify(value));
}

export function clearPendingIngest() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(PENDING_INGEST_KEY);
}

export function fileMatchesPending(
  file: File,
  source: RecordingSource,
  pending: PendingIngest,
) {
  return (
    pending.source === source &&
    pending.fileName === file.name &&
    pending.fileSize === file.size &&
    pending.fileType === file.type &&
    pending.fileLastModified === file.lastModified
  );
}
