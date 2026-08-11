import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/domain/models";
import {
  appendUploadChunk,
  createResumableUploadSession,
  finalizeResumableUploadSession,
  getResumableUploadSession,
} from "@/server/ingest/service";
import { createLocalUser, toPrincipal } from "@/server/auth/service";
import { resetAppDatabaseForTests } from "@/server/db/client";
import { readState, withState } from "@/server/store";

const { dispatchRecordingToConfiguredEngineMock } = vi.hoisted(() => ({
  dispatchRecordingToConfiguredEngineMock: vi.fn(),
}));

vi.mock("@/server/orchestration/dispatch", () => ({
  dispatchRecordingToConfiguredEngine: dispatchRecordingToConfiguredEngineMock,
}));

let uploaderPrincipal: Principal;
let otherUploaderPrincipal: Principal;
let adminPrincipal: Principal;

describe("resumable ingest service", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-ingest-"));
    process.env.SUPERSCRIBER_DB_PATH = ":memory:";
    process.env.SUPERSCRIBER_UPLOAD_TMP_DIR = join(tempRoot, "uploads");
    process.env.SUPERSCRIBER_MEDIA_DIR = join(tempRoot, "media");
    resetAppDatabaseForTests();
    dispatchRecordingToConfiguredEngineMock.mockReset();
    dispatchRecordingToConfiguredEngineMock.mockResolvedValue({
      mode: "mock",
      dispatched: false,
      message: "Using mock orchestration mode. No external engine dispatch was attempted.",
    });

    uploaderPrincipal = toPrincipal(
      await createLocalUser({
        displayName: "Uploader One",
        email: "uploader-1@example.com",
        password: "password123",
        role: "uploader",
      }),
    );
    otherUploaderPrincipal = toPrincipal(
      await createLocalUser({
        displayName: "Uploader Two",
        email: "uploader-2@example.com",
        password: "password123",
        role: "uploader",
      }),
    );
    adminPrincipal = toPrincipal(
      await createLocalUser({
        displayName: "Admin One",
        email: "admin@example.com",
        password: "password123",
        role: "admin",
      }),
    );
  });

  afterEach(() => {
    resetAppDatabaseForTests();
    delete process.env.SUPERSCRIBER_DB_PATH;
    delete process.env.SUPERSCRIBER_UPLOAD_TMP_DIR;
    delete process.env.SUPERSCRIBER_MEDIA_DIR;
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("records creator ownership and audit attribution for uploader-created sessions", () => {
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 001",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: 16,
    });

    const state = readState();
    const recording = state.recordings.find((entry) => entry.id === session.recordingId);
    const ingest = state.ingestionSessions.find((entry) => entry.id === session.sessionId);
    const audit = state.auditEvents.find((entry) => entry.recordingId === session.recordingId);

    expect(recording?.uploadedByRole).toBe("uploader");
    expect(recording?.uploadedByUserId).toBe(uploaderPrincipal.userId);
    expect(ingest?.createdByUserId).toBe(uploaderPrincipal.userId);
    expect(audit).toMatchObject({
      actorRole: uploaderPrincipal.role,
      actorUserId: uploaderPrincipal.userId,
      actorDisplayName: uploaderPrincipal.displayName,
      effectiveRole: uploaderPrincipal.role,
      type: "recording.created",
    });
  });

  it("keeps the chosen transcription model attached to the recording (demo-advanced-model-picker)", () => {
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Model-picked interview",
      languageHint: "english",
      transcriptModel: "tiny",
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: 16,
    });

    const state = readState();
    const recording = state.recordings.find((entry) => entry.id === session.recordingId);
    expect(recording?.transcriptModel).toBe("tiny");
  });

  it("leaves transcriptModel null when the picker was never touched", () => {
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Default-model interview",
      languageHint: "english",
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: 16,
    });

    const state = readState();
    const recording = state.recordings.find((entry) => entry.id === session.recordingId);
    expect(recording?.transcriptModel).toBeNull();
  });

  it("allows an admin creator to inspect, append, and finalize their own session", async () => {
    const payload = Buffer.from("admin-upload");
    const session = createResumableUploadSession({
      principal: adminPrincipal,
      title: "Admin Interview",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "admin.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    expect(getResumableUploadSession(session.sessionId, adminPrincipal).sessionId).toBe(
      session.sessionId,
    );

    appendUploadChunk({
      principal: adminPrincipal,
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload,
    });

    const finalized = await finalizeResumableUploadSession(session.sessionId, adminPrincipal);
    expect(finalized.integrityState).toBe("verified");

    const state = readState();
    const recording = state.recordings.find((entry) => entry.id === session.recordingId);
    expect(recording?.uploadedByUserId).toBe(adminPrincipal.userId);
  });

  it("denies a non-owner uploader from inspecting, appending, or finalizing another session", async () => {
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 002",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    expect(() => getResumableUploadSession(session.sessionId, otherUploaderPrincipal)).toThrowError(
      expect.objectContaining({
        code: "ACCESS_DENIED",
        message: "This upload session is not available to your account.",
      }),
    );
    expect(() =>
      appendUploadChunk({
        principal: otherUploaderPrincipal,
        sessionId: session.sessionId,
        chunkStart: 0,
        bytes: payload,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ACCESS_DENIED",
        message: "This upload session is not available to your account.",
      }),
    );
    await expect(
      finalizeResumableUploadSession(session.sessionId, otherUploaderPrincipal),
    ).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      message: "This upload session is not available to your account.",
    });
  });

  it("allows admin inspection but denies mutation of another user's session", async () => {
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 003",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    expect(getResumableUploadSession(session.sessionId, adminPrincipal).sessionId).toBe(
      session.sessionId,
    );
    expect(() =>
      appendUploadChunk({
        principal: adminPrincipal,
        sessionId: session.sessionId,
        chunkStart: 0,
        bytes: payload,
      }),
    ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
    await expect(finalizeResumableUploadSession(session.sessionId, adminPrincipal)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  });

  it("treats legacy ownerless sessions as admin-inspect only", () => {
    const payload = Buffer.from("legacy-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Legacy Interview",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "legacy.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    withState((state) => {
      const ingest = state.ingestionSessions.find((entry) => entry.id === session.sessionId);
      const recording = state.recordings.find((entry) => entry.id === session.recordingId);
      if (!ingest || !recording) {
        throw new Error("Expected upload session.");
      }

      ingest.createdByUserId = null;
      recording.uploadedByUserId = null;
    });

    expect(getResumableUploadSession(session.sessionId, adminPrincipal).sessionId).toBe(
      session.sessionId,
    );
    expect(() => getResumableUploadSession(session.sessionId, uploaderPrincipal)).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
    expect(() =>
      appendUploadChunk({
        principal: adminPrincipal,
        sessionId: session.sessionId,
        chunkStart: 0,
        bytes: payload,
      }),
    ).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED" }));
  });

  it("validates trimmed title length before creating durable state", () => {
    expect(() =>
      createResumableUploadSession({
        principal: uploaderPrincipal,
        title: "   ",
        languageHint: "english",
        transcriptModel: null,
        source: "upload",
        fileName: "interview.wav",
        mimeType: "audio/wav",
        fileSize: 16,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
        fieldErrors: { title: "Enter a title between 1 and 120 characters." },
      }),
    );

    expect(() =>
      createResumableUploadSession({
        principal: uploaderPrincipal,
        title: "x".repeat(121),
        languageHint: "english",
        transcriptModel: null,
        source: "upload",
        fileName: "interview.wav",
        mimeType: "audio/wav",
        fileSize: 16,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_ERROR",
        fieldErrors: { title: "Enter a title between 1 and 120 characters." },
      }),
    );

    const state = readState();
    expect(state.recordings.map((entry) => entry.id)).toEqual([
      "rec-seed-review",
      "rec-seed-approval",
      "rec-seed-running",
    ]);
    expect(state.ingestionSessions.map((entry) => entry.id)).toEqual([
      "ingest-seed-review",
      "ingest-seed-approval",
      "ingest-seed-running",
    ]);
  });

  it("supports same-file resume from the last committed byte", () => {
    const payload = Buffer.from("resume-me-safely");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 004",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "resume.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload.subarray(0, 6),
    });

    const resumed = getResumableUploadSession(session.sessionId, uploaderPrincipal);
    expect(resumed.bytesReceived).toBe(6);
    expect(resumed.nextAction).toBe("resume");
    expect(readFileSync(join(process.env.SUPERSCRIBER_UPLOAD_TMP_DIR ?? "", `${session.sessionId}.upload`), "utf8")).toBe(
      payload.subarray(0, 6).toString("utf8"),
    );

    const completed = appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: resumed.bytesReceived,
      bytes: payload.subarray(6),
    });

    expect(completed.bytesReceived).toBe(payload.length);
    expect(completed.nextAction).toBe("finalize");
    expect(readFileSync(join(process.env.SUPERSCRIBER_UPLOAD_TMP_DIR ?? "", `${session.sessionId}.upload`), "utf8")).toBe(
      payload.toString("utf8"),
    );
  });

  it("returns a warning when durable finalize succeeds but dispatch fails", async () => {
    dispatchRecordingToConfiguredEngineMock.mockRejectedValueOnce(new Error("Engine unavailable."));
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 005",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload,
    });

    const finalized = await finalizeResumableUploadSession(session.sessionId, uploaderPrincipal);
    expect(finalized.integrityState).toBe("verified");
    expect(finalized.warning).toBe("Upload stored, but backend dispatch failed: Engine unavailable.");

    withState((state) => {
      const ingest = state.ingestionSessions.find((entry) => entry.id === session.sessionId);
      if (!ingest) {
        throw new Error("Expected ingest session.");
      }
      ingest.lastError = "Engine unavailable.";
      ingest.verificationSummary = "Engine unavailable.";
    });
    expect(getResumableUploadSession(session.sessionId, uploaderPrincipal).warning).toBe(
      "Upload stored, but backend dispatch failed: Engine unavailable.",
    );

    const state = readState();
    const recording = state.recordings.find((entry) => entry.id === session.recordingId);
    expect(recording?.mediaPath).toBeTruthy();
    expect(readFileSync(recording?.mediaPath ?? "", "utf8")).toBe("governed-upload");
  });

  it("expires stale incomplete uploads and forces restart", () => {
    const payload = Buffer.from("resume-me");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 006",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload.subarray(0, 4),
    });

    withState((state) => {
      const ingest = state.ingestionSessions.find((entry) => entry.id === session.sessionId);
      const recording = state.recordings.find((entry) => entry.id === session.recordingId);
      if (!ingest || !recording) {
        throw new Error("Expected ingest session.");
      }

      const oldTimestamp = new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString();
      ingest.updatedAt = oldTimestamp;
      recording.updatedAt = oldTimestamp;
    });

    const expired = getResumableUploadSession(session.sessionId, uploaderPrincipal);
    expect(expired.nextAction).toBe("restart");
    expect(expired.state).toBe("interrupted");
    expect(expired.verificationSummary).toBe(
      "Temporary upload expired and was cleaned up. Start a new upload session to continue.",
    );
  });

  it("fails finalize when the temporary upload is missing and forces restart", async () => {
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 007",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload,
    });

    unlinkSync(join(process.env.SUPERSCRIBER_UPLOAD_TMP_DIR ?? "", `${session.sessionId}.upload`));

    await expect(
      finalizeResumableUploadSession(session.sessionId, uploaderPrincipal),
    ).rejects.toMatchObject({
      code: "STATE_CHANGED",
      message: "Temporary upload is missing. Start a new upload session.",
    });

    const failed = getResumableUploadSession(session.sessionId, uploaderPrincipal);
    expect(failed.state).toBe("verification_failed");
    expect(failed.nextAction).toBe("restart");
  });

  it("fails finalize when uploaded bytes do not match the expected size", async () => {
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 007b",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload.subarray(0, payload.length - 1),
    });

    withState((state) => {
      const ingest = state.ingestionSessions.find((entry) => entry.id === session.sessionId);
      if (!ingest) {
        throw new Error("Expected ingest session.");
      }

      ingest.bytesReceived = payload.length;
    });

    await expect(
      finalizeResumableUploadSession(session.sessionId, uploaderPrincipal),
    ).rejects.toMatchObject({
      code: "STATE_CHANGED",
      message:
        "Upload verification failed because the received bytes do not match the expected size. Restart the upload.",
    });

    const failed = getResumableUploadSession(session.sessionId, uploaderPrincipal);
    expect(failed.state).toBe("verification_failed");
    expect(failed.nextAction).toBe("restart");
  });

  it("uses stable safe error codes for offset mismatches without leaking filesystem paths", () => {
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 008",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    expect(() =>
      appendUploadChunk({
        principal: uploaderPrincipal,
        sessionId: session.sessionId,
        chunkStart: 4,
        bytes: payload,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "STATE_CHANGED",
        message: "Upload is out of sync. Resume from the latest committed byte.",
      }),
    );

    try {
      appendUploadChunk({
        principal: uploaderPrincipal,
        sessionId: session.sessionId,
        chunkStart: 4,
        bytes: payload,
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "STATE_CHANGED" });
      expect(String(error)).not.toContain(tempRoot);
    }
  });

  it("creates a resumable session, appends chunks, and finalizes into media storage", async () => {
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      principal: uploaderPrincipal,
      title: "Interview 009",
      languageHint: "english",
      transcriptModel: null,
      source: "upload",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    expect(session.bytesReceived).toBe(0);
    expect(session.nextAction).toBe("resume");

    const firstHalf = appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload.subarray(0, 8),
    });
    expect(firstHalf.bytesReceived).toBe(8);

    const secondHalf = appendUploadChunk({
      principal: uploaderPrincipal,
      sessionId: session.sessionId,
      chunkStart: 8,
      bytes: payload.subarray(8),
    });
    expect(secondHalf.bytesReceived).toBe(payload.length);
    expect(secondHalf.nextAction).toBe("finalize");

    const finalized = await finalizeResumableUploadSession(session.sessionId, uploaderPrincipal);
    expect(finalized.recordingId).toBe(session.recordingId);
    expect(finalized.integrityState).toBe("verified");

    const state = readState();
    const recording = state.recordings.find((entry) => entry.id === session.recordingId);
    expect(recording?.mediaPath).toBeTruthy();
    expect(recording?.verificationSummary).toBe(
      "Upload verified locally and queued for transcription.",
    );
    expect(readFileSync(recording?.mediaPath ?? "", "utf8")).toBe("governed-upload");
    expect(existsSync(join(process.env.SUPERSCRIBER_UPLOAD_TMP_DIR ?? "", `${session.sessionId}.upload`))).toBe(false);
  });
});
