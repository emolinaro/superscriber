import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
import { type IngestionSession, type Principal, type Recording, type RecordingSource } from "@/domain/models";
import type { ErrorCode } from "@/lib/command-result";
import { dispatchRecordingToConfiguredEngine } from "@/server/orchestration/dispatch";
import { dispatchWarningFromLastError } from "@/server/orchestration/dispatch-warning";
import { getConfiguredAdapterId } from "@/server/orchestration/config";
import { MEDIA_DIR, readState, withState } from "@/server/store";

const UPLOAD_EXPIRY_MS = 1000 * 60 * 60 * 24;
const TITLE_ERROR_MESSAGE = "Enter a title between 1 and 120 characters.";
const AUTH_EXPIRED_ERROR_MESSAGE = "Session expired. Sign in again to continue.";
const INTERNAL_ERROR_MESSAGE = "Something went wrong. Try again.";

export class IngestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "IngestError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function describeIngestFailure(error: unknown) {
  if (error instanceof IngestError) {
    return {
      status: statusForErrorCode(error.code),
      body: {
        ok: false as const,
        code: error.code,
        error: error.message,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      },
    };
  }

  return {
    status: 500,
    body: {
      ok: false as const,
      code: "INTERNAL_ERROR" as const,
      error: INTERNAL_ERROR_MESSAGE,
    },
  };
}

export function authExpiredIngestFailure() {
  return {
    status: 401,
    body: {
      ok: false as const,
      code: "AUTH_EXPIRED" as const,
      error: AUTH_EXPIRED_ERROR_MESSAGE,
    },
  };
}

function statusForErrorCode(code: ErrorCode) {
  if (code === "AUTH_EXPIRED") {
    return 401;
  }
  if (code === "ACCESS_DENIED") {
    return 403;
  }
  if (code === "NOT_FOUND") {
    return 404;
  }
  if (code === "VALIDATION_ERROR") {
    return 400;
  }
  if (code === "STATE_CHANGED") {
    return 409;
  }

  return 500;
}

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

function findUploadState(state: ReturnType<typeof readState>, sessionId: string) {
  const session = state.ingestionSessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new IngestError("NOT_FOUND", "Upload session not found.");
  }

  const recording = state.recordings.find((entry) => entry.id === session.recordingId);
  if (!recording) {
    throw new IngestError("NOT_FOUND", "Upload session not found.");
  }

  return { session, recording };
}

function buildSessionStatus(state: ReturnType<typeof readState>, sessionId: string) {
  const { session, recording } = findUploadState(state, sessionId);
  const tempPath = uploadTempPath(session.id);
  const tempExists = existsSync(tempPath);
  const bytesReceived = session.bytesReceived ?? 0;
  const bytesExpected = session.bytesExpected ?? 0;
  const completed = bytesExpected > 0 && bytesReceived >= bytesExpected;
  const warning = recording.mediaPath
    ? dispatchWarningFromLastError(session.lastError)
    : null;

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
    warning,
    verificationSummary: session.verificationSummary,
    title: recording.title,
    source: recording.source,
    mediaPath: recording.mediaPath,
    tempFilePresent: tempExists,
  };
}

function assertUploaderOrAdmin(principal: Principal) {
  if (principal.role === "uploader" || principal.role === "admin") {
    return;
  }

  throw new IngestError(
    "ACCESS_DENIED",
    "Only uploader and admin accounts can manage ingest sessions.",
  );
}

function validateTitle(title: string) {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length < 1 || trimmedTitle.length > 120) {
    throw new IngestError("VALIDATION_ERROR", TITLE_ERROR_MESSAGE, {
      title: TITLE_ERROR_MESSAGE,
    });
  }

  return trimmedTitle;
}

function assertSessionAccess(
  session: IngestionSession,
  principal: Principal,
  mode: "inspect" | "mutate",
) {
  if (session.createdByUserId === principal.userId) {
    return;
  }
  if (mode === "inspect" && principal.role === "admin") {
    return;
  }

  throw new IngestError(
    "ACCESS_DENIED",
    "This upload session is not available to your account.",
  );
}

function idempotentSessionId(userId: string, idempotencyKey: string) {
  const digest = createHash("sha256")
    .update(userId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
  return `ingest-idempotent-${digest}`;
}

export function createResumableUploadSession(params: {
  principal: Principal;
  title: string;
  languageHint: string;
  /** demo-advanced-model-picker */
  transcriptModel?: string | null;
  source: RecordingSource;
  fileName: string;
  mimeType: string | null;
  fileSize: number;
  idempotencyKey?: string | null;
}) {
  assertUploaderOrAdmin(params.principal);
  const title = validateTitle(params.title);
  ensureUploadDirs();
  const requestedSessionId = params.idempotencyKey
    ? idempotentSessionId(params.principal.userId, params.idempotencyKey)
    : null;

  const result = withState((state) => {
    cleanupExpiredUploadsInState(state);
    if (requestedSessionId) {
      const existing = state.ingestionSessions.find((entry) => entry.id === requestedSessionId);
      if (existing) {
        assertSessionAccess(existing, params.principal, "mutate");
        return {
          created: false,
          sessionId: existing.id,
        };
      }
    }

    const created = createUploadSessionEntry({
      state,
      workspaceId: state.workspaces[0]?.id ?? "workspace-regulated",
      title,
      source: params.source,
      mediaKind: mediaKindForMime(params.mimeType),
      mimeType: params.mimeType,
      originalFileName: params.fileName ? fileSafeName(params.fileName) : null,
      languageHint: params.languageHint || "english",
      transcriptModel: params.transcriptModel ?? null,
      principal: params.principal,
      bytesExpected: params.fileSize,
      adapterId: getConfiguredAdapterId(),
      sessionId: requestedSessionId ?? undefined,
    });

    return {
      created: true,
      sessionId: created.ingestionSession.id,
    };
  });

  if (result.created) {
    writeFileSync(uploadTempPath(result.sessionId), Buffer.alloc(0));
  }
  const refreshed = readState();
  return buildSessionStatus(refreshed, result.sessionId);
}

export function getResumableUploadSession(sessionId: string, principal: Principal) {
  assertUploaderOrAdmin(principal);

  return withState((state) => {
    cleanupExpiredUploadsInState(state);
    const { session } = findUploadState(state, sessionId);
    assertSessionAccess(session, principal, "inspect");
    return buildSessionStatus(state, sessionId);
  });
}

export function appendUploadChunk(params: {
  principal: Principal;
  sessionId: string;
  chunkStart: number;
  bytes: Uint8Array;
}) {
  assertUploaderOrAdmin(params.principal);
  ensureUploadDirs();
  const tempPath = uploadTempPath(params.sessionId);

  return withState((state) => {
    cleanupExpiredUploadsInState(state);
    const { session } = findUploadState(state, params.sessionId);
    assertSessionAccess(session, params.principal, "mutate");

    if (session.state === "verification_failed") {
      throw new IngestError(
        "STATE_CHANGED",
        "This upload session needs a restart before more bytes can be accepted.",
      );
    }

    const expectedOffset = session.bytesReceived ?? 0;
    if (params.chunkStart !== expectedOffset) {
      throw new IngestError(
        "STATE_CHANGED",
        "Upload is out of sync. Resume from the latest committed byte.",
      );
    }

    if (!existsSync(tempPath) && expectedOffset > 0) {
      throw new IngestError(
        "STATE_CHANGED",
        "This upload session was cleaned up and must be restarted.",
      );
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

export async function finalizeResumableUploadSession(sessionId: string, principal: Principal) {
  assertUploaderOrAdmin(principal);
  ensureUploadDirs();
  const tempPath = uploadTempPath(sessionId);

  const finalized = withState((state) => {
    cleanupExpiredUploadsInState(state);
    const { session, recording } = findUploadState(state, sessionId);
    assertSessionAccess(session, principal, "mutate");
    const expected = session.bytesExpected ?? 0;
    const received = session.bytesReceived ?? 0;

    if (!existsSync(tempPath)) {
      failUploadSession({
        state,
        sessionId,
        detail: "Temporary upload is missing. Start a new upload session.",
      });
      return {
        ok: false as const,
        error: new IngestError(
          "STATE_CHANGED",
          "Temporary upload is missing. Start a new upload session.",
        ),
      };
    }

    const stats = statSync(tempPath);
    if (received !== expected || stats.size !== expected) {
      failUploadSession({
        state,
        sessionId,
        detail:
          "Upload verification failed because the received bytes do not match the expected size. Restart the upload.",
      });
      return {
        ok: false as const,
        error: new IngestError(
          "STATE_CHANGED",
          "Upload verification failed because the received bytes do not match the expected size. Restart the upload.",
        ),
      };
    }

    const finalPath = nextMediaPath(recording.id, recording.originalFileName);
    renameSync(tempPath, finalPath);
    finalizeUploadSession({
      state,
      sessionId,
      mediaPath: finalPath,
      mimeType: recording.mimeType,
      principal,
    });

    return {
      ok: true as const,
      recordingId: recording.id,
      mediaPath: finalPath,
    };
  });

  if (!finalized.ok) {
    throw finalized.error;
  }

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

  const status = getResumableUploadSession(sessionId, principal);
  return {
    ...status,
    warning,
  };
}
