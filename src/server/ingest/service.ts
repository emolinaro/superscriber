import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import {
  createUploadSessionEntry,
  expireUploadSession,
  failUploadSession,
  finalizeUploadSession,
  noteUploadProgress,
} from "@/domain/workflow";
import { type Recording, type RecordingSource, type UserRole } from "@/domain/models";
import { dispatchRecordingToConfiguredEngine } from "@/server/orchestration/dispatch";
import { getConfiguredAdapterId } from "@/server/orchestration/config";
import { MEDIA_DIR, readState, withState } from "@/server/store";

const UPLOAD_EXPIRY_MS = 1000 * 60 * 60 * 24;

function nowMs() {
  return Date.now();
}

function ensureUploadDirs() {
  mkdirSync(resolveUploadTempDir(), { recursive: true });
  mkdirSync(resolveMediaDir(), { recursive: true });
}

function mediaKindForMime(mimeType: string | null): Recording["mediaKind"] {
  return mimeType?.startsWith("video/") ? "video" : "audio";
}

function fileSafeName(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function uploadTempPath(sessionId: string) {
  return join(resolveUploadTempDir(), `${sessionId}.upload`);
}

function nextMediaPath(recordingId: string, originalFileName: string | null) {
  const extension = extname(originalFileName || "") || ".bin";
  return join(resolveMediaDir(), `${recordingId}-${crypto.randomUUID()}${extension}`);
}

function resolveUploadTempDir() {
  return process.env.SUPERSCRIBER_UPLOAD_TMP_DIR?.trim() || join(process.cwd(), "data", "uploads");
}

function resolveMediaDir() {
  return process.env.SUPERSCRIBER_MEDIA_DIR?.trim() || MEDIA_DIR;
}

function cleanupExpiredUploadsInState(state: ReturnType<typeof readState>) {
  const expiryCutoff = nowMs() - UPLOAD_EXPIRY_MS;

  for (const session of state.ingestionSessions) {
    const isIncomplete =
      (session.state === "uploading" || session.state === "interrupted") &&
      session.bytesExpected !== null &&
      session.bytesReceived !== null &&
      session.bytesReceived < session.bytesExpected;

    if (!isIncomplete) {
      continue;
    }

    const updatedMs = Date.parse(session.updatedAt);
    if (Number.isNaN(updatedMs) || updatedMs >= expiryCutoff) {
      continue;
    }

    const tempPath = uploadTempPath(session.id);
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }

    expireUploadSession({
      state,
      sessionId: session.id,
      detail:
        "Temporary upload expired and was cleaned up. Start a new upload session to continue.",
    });
  }
}

function findUploadState(
  state: ReturnType<typeof readState>,
  sessionId: string,
) {
  const session = state.ingestionSessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("Upload session not found.");
  }

  const recording = state.recordings.find((entry) => entry.id === session.recordingId);
  if (!recording) {
    throw new Error("Recording not found.");
  }

  return { session, recording };
}

function buildSessionStatus(
  state: ReturnType<typeof readState>,
  sessionId: string,
) {
  const { session, recording } = findUploadState(state, sessionId);
  const tempPath = uploadTempPath(session.id);
  const tempExists = existsSync(tempPath);
  const bytesReceived = session.bytesReceived ?? 0;
  const bytesExpected = session.bytesExpected ?? 0;
  const completed = bytesExpected > 0 && bytesReceived >= bytesExpected;

  let nextAction: "resume" | "restart" | "finalize" | "none" = "resume";
  if (session.state === "verification_failed") {
    nextAction = "restart";
  } else if (session.state === "interrupted" && !tempExists) {
    nextAction = "restart";
  } else if (completed && tempExists) {
    nextAction = "finalize";
  } else if (recording.integrityState === "verifying" || session.state === "verified") {
    nextAction = "none";
  }

  return {
    sessionId: session.id,
    recordingId: recording.id,
    state: session.state,
    integrityState: recording.integrityState,
    bytesReceived,
    bytesExpected,
    progressPercent:
      bytesExpected > 0 ? Math.min(Math.round((bytesReceived / bytesExpected) * 100), 100) : 0,
    resumeToken: session.resumeToken,
    nextAction,
    verificationSummary: session.verificationSummary,
    title: recording.title,
    source: recording.source,
    mediaPath: recording.mediaPath,
    tempFilePresent: tempExists,
  };
}

export function createResumableUploadSession(params: {
  title: string;
  languageHint: string;
  source: RecordingSource;
  role: UserRole;
  fileName: string;
  mimeType: string | null;
  fileSize: number;
}) {
  ensureUploadDirs();

  const result = withState((state) => {
    cleanupExpiredUploadsInState(state);

    const created = createUploadSessionEntry({
      state,
      workspaceId: state.workspaces[0]?.id ?? "workspace-regulated",
      title: params.title.trim() || params.fileName || "Untitled recording",
      source: params.source,
      mediaKind: mediaKindForMime(params.mimeType),
      mimeType: params.mimeType,
      originalFileName: params.fileName ? fileSafeName(params.fileName) : null,
      languageHint: params.languageHint || "english",
      role: params.role,
      bytesExpected: params.fileSize,
      adapterId: getConfiguredAdapterId(),
    });

    return {
      sessionId: created.ingestionSession.id,
      recordingId: created.recording.id,
    };
  });

  writeFileSync(uploadTempPath(result.sessionId), Buffer.alloc(0));
  const refreshed = readState();
  return buildSessionStatus(refreshed, result.sessionId);
}

export function getResumableUploadSession(sessionId: string) {
  return withState((state) => {
    cleanupExpiredUploadsInState(state);
    return buildSessionStatus(state, sessionId);
  });
}

export function appendUploadChunk(params: {
  sessionId: string;
  chunkStart: number;
  bytes: Uint8Array;
}) {
  ensureUploadDirs();
  const tempPath = uploadTempPath(params.sessionId);

  return withState((state) => {
    cleanupExpiredUploadsInState(state);
    const { session } = findUploadState(state, params.sessionId);

    if (session.state === "verification_failed") {
      throw new Error("This upload session needs a restart before more bytes can be accepted.");
    }

    const expectedOffset = session.bytesReceived ?? 0;
    if (params.chunkStart !== expectedOffset) {
      throw new Error(
        `Chunk offset mismatch. Server expects byte ${expectedOffset}, received ${params.chunkStart}.`,
      );
    }

    if (!existsSync(tempPath) && expectedOffset > 0) {
      throw new Error("This upload session was cleaned up and must be restarted.");
    }

    const fd = openSync(tempPath, expectedOffset === 0 ? "w" : "r+");
    try {
      writeSync(fd, params.bytes, 0, params.bytes.length, params.chunkStart);
    } finally {
      closeSync(fd);
    }

    const nextBytes = expectedOffset + params.bytes.length;
    noteUploadProgress({
      state,
      sessionId: params.sessionId,
      bytesReceived: nextBytes,
    });

    return buildSessionStatus(state, params.sessionId);
  });
}

export async function finalizeResumableUploadSession(sessionId: string) {
  ensureUploadDirs();
  const tempPath = uploadTempPath(sessionId);

  const finalized = withState((state) => {
    cleanupExpiredUploadsInState(state);
    const { session, recording } = findUploadState(state, sessionId);
    const expected = session.bytesExpected ?? 0;
    const received = session.bytesReceived ?? 0;

    if (!existsSync(tempPath)) {
      failUploadSession({
        state,
        sessionId,
        detail: "Temporary upload is missing. Start a new upload session.",
      });
      throw new Error("Temporary upload is missing. Start a new upload session.");
    }

    const stats = statSync(tempPath);
    if (received !== expected || stats.size !== expected) {
      failUploadSession({
        state,
        sessionId,
        detail:
          "Upload verification failed because the received bytes do not match the expected size. Restart the upload.",
      });
      throw new Error(
        "Upload verification failed because the received bytes do not match the expected size.",
      );
    }

    const finalPath = nextMediaPath(recording.id, recording.originalFileName);
    renameSync(tempPath, finalPath);
    finalizeUploadSession({
      state,
      sessionId,
      mediaPath: finalPath,
      mimeType: recording.mimeType,
    });

    return {
      recordingId: recording.id,
      mediaPath: finalPath,
    };
  });

  let warning: string | null = null;
  try {
    const dispatchResult = await dispatchRecordingToConfiguredEngine(finalized.recordingId);
    if (dispatchResult.mode === "webhook" && dispatchResult.dispatched) {
      warning = null;
    }
  } catch (error) {
    warning =
      error instanceof Error
        ? `Upload stored, but backend dispatch failed: ${error.message}`
        : "Upload stored, but backend dispatch failed.";
  }

  const status = getResumableUploadSession(sessionId);
  return {
    ...status,
    warning,
  };
}
