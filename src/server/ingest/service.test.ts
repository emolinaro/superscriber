import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendUploadChunk, createResumableUploadSession, finalizeResumableUploadSession, getResumableUploadSession } from "@/server/ingest/service";
import { resetAppDatabaseForTests } from "@/server/db/client";
import { readState, withState } from "@/server/store";

describe("resumable ingest service", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-ingest-"));
    process.env.SUPERSCRIBER_DB_PATH = ":memory:";
    process.env.SUPERSCRIBER_UPLOAD_TMP_DIR = join(tempRoot, "uploads");
    process.env.SUPERSCRIBER_MEDIA_DIR = join(tempRoot, "media");
    resetAppDatabaseForTests();
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

  it("creates a resumable session, appends chunks, and finalizes into media storage", async () => {
    const payload = Buffer.from("governed-upload");
    const session = createResumableUploadSession({
      title: "Interview 001",
      languageHint: "english",
      source: "upload",
      role: "uploader",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    expect(session.bytesReceived).toBe(0);
    expect(session.nextAction).toBe("resume");

    const firstHalf = appendUploadChunk({
      sessionId: session.sessionId,
      chunkStart: 0,
      bytes: payload.subarray(0, 8),
    });
    expect(firstHalf.bytesReceived).toBe(8);

    const secondHalf = appendUploadChunk({
      sessionId: session.sessionId,
      chunkStart: 8,
      bytes: payload.subarray(8),
    });
    expect(secondHalf.bytesReceived).toBe(payload.length);
    expect(secondHalf.nextAction).toBe("finalize");

    const finalized = await finalizeResumableUploadSession(session.sessionId);
    expect(finalized.recordingId).toBe(session.recordingId);
    expect(finalized.integrityState).toBe("verified");

    const state = readState();
    const recording = state.recordings.find((entry) => entry.id === session.recordingId);
    expect(recording?.mediaPath).toBeTruthy();
    expect(recording?.verificationSummary).toBe(
      "Upload verified locally and queued for transcription.",
    );
    expect(readFileSync(recording?.mediaPath ?? "", "utf8")).toBe("governed-upload");
  });

  it("expires stale incomplete uploads and forces restart", () => {
    const payload = Buffer.from("resume-me");
    const session = createResumableUploadSession({
      title: "Interview 002",
      languageHint: "english",
      source: "upload",
      role: "uploader",
      fileName: "interview.wav",
      mimeType: "audio/wav",
      fileSize: payload.length,
    });

    appendUploadChunk({
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

    const expired = getResumableUploadSession(session.sessionId);
    expect(expired.nextAction).toBe("restart");
    expect(expired.state).toBe("interrupted");
  });
});
