"use client";

import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const CHUNK_SIZE = 1024 * 1024;
const PENDING_INGEST_KEY = "superscriber.pendingIngest";

type UploadSessionStatus = {
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
  source: "upload" | "record";
  mediaPath: string | null;
  tempFilePresent: boolean;
};

type PendingIngest = {
  sessionId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  fileLastModified: number;
  source: "upload" | "record";
};

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readPendingIngest() {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(PENDING_INGEST_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PendingIngest;
  } catch {
    window.localStorage.removeItem(PENDING_INGEST_KEY);
    return null;
  }
}

function writePendingIngest(value: PendingIngest) {
  window.localStorage.setItem(PENDING_INGEST_KEY, JSON.stringify(value));
}

function clearPendingIngest() {
  window.localStorage.removeItem(PENDING_INGEST_KEY);
}

function fileMatchesPending(file: File, source: "upload" | "record", pending: PendingIngest) {
  return (
    pending.source === source &&
    pending.fileName === file.name &&
    pending.fileSize === file.size &&
    pending.fileType === file.type &&
    pending.fileLastModified === file.lastModified
  );
}

async function readJson<T>(response: Response) {
  const parsed = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok || parsed.ok === false) {
    throw new Error(parsed.error || "The request failed.");
  }

  return parsed;
}

export function IngestPanel() {
  const router = useRouter();
  const [mode, setMode] = useState<"upload" | "record">("upload");
  const [recorderState, setRecorderState] = useState<
    "idle" | "recording" | "ready" | "unsupported" | "denied"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recordedFileName, setRecordedFileName] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<
    "idle" | "preparing" | "uploading" | "resumable" | "finalizing" | "error"
  >("idle");
  const [statusMessage, setStatusMessage] = useState(
    "Choose a file or record audio to begin a governed ingest session.",
  );
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressDetail, setProgressDetail] = useState<string | null>(null);
  const [resumableNotice, setResumableNotice] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recordedInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const languageSelectRef = useRef<HTMLSelectElement | null>(null);

  const attachRecordedBlob = useEffectEvent((blob: Blob) => {
    const file = new File([blob], `recording-${Date.now()}.webm`, {
      type: blob.type || "audio/webm",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);

    if (recordedInputRef.current) {
      recordedInputRef.current.files = transfer.files;
    }

    setRecordedFileName(file.name);
    setPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return URL.createObjectURL(blob);
    });
  });

  useEffect(() => {
    const pending = readPendingIngest();
    if (!pending) {
      return;
    }

    fetch(`/api/ingest/sessions/${pending.sessionId}`, {
      cache: "no-store",
    })
      .then((response) => readJson<{ ok: true; status: UploadSessionStatus }>(response))
      .then(({ status }) => {
        if (status.nextAction === "resume") {
          setResumableNotice(
            `Resumable upload found for ${pending.fileName}. Choose the same file and continue from ${formatBytes(status.bytesReceived)}.`,
          );
        } else if (status.nextAction === "restart") {
          clearPendingIngest();
          setResumableNotice(
            "A previous upload session expired or needs a restart. Start a new session to continue.",
          );
        } else if (status.nextAction === "finalize") {
          setResumableNotice(
            `Upload bytes are already on the server for ${pending.fileName}. Choosing the same file will finalize verification.`,
          );
        }
      })
      .catch(() => {
        clearPendingIngest();
      });
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [previewUrl]);

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setRecorderState("unsupported");
      return;
    }

    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      chunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      streamRef.current = stream;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        attachRecordedBlob(blob);
        stream.getTracks().forEach((track) => track.stop());
        setRecorderState("ready");
      });

      recorder.start();
      setRecorderState("recording");
      setStatusMessage("Recording in progress. Stop when you are ready to upload.");
    } catch {
      setRecorderState("denied");
    }
  }

  function stopRecording() {
    if (!recorderRef.current || recorderRef.current.state === "inactive") {
      return;
    }

    recorderRef.current.stop();
  }

  function selectedFile() {
    if (mode === "record") {
      return recordedInputRef.current?.files?.[0] ?? null;
    }

    return fileInputRef.current?.files?.[0] ?? null;
  }

  async function createSession(file: File, source: "upload" | "record") {
    const response = await fetch("/api/ingest/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: titleInputRef.current?.value ?? "",
        languageHint: languageSelectRef.current?.value ?? "english",
        source,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      }),
    });

    const { status } = await readJson<{ ok: true; status: UploadSessionStatus }>(response);
    writePendingIngest({
      sessionId: status.sessionId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      fileLastModified: file.lastModified,
      source,
    });
    return status;
  }

  async function loadExistingSession(sessionId: string) {
    const response = await fetch(`/api/ingest/sessions/${sessionId}`, {
      cache: "no-store",
    });
    const { status } = await readJson<{ ok: true; status: UploadSessionStatus }>(response);
    return status;
  }

  async function uploadFile(file: File, session: UploadSessionStatus) {
    let offset = session.bytesReceived;
    setProgressPercent(session.progressPercent);
    setProgressDetail(`${formatBytes(offset)} of ${formatBytes(session.bytesExpected)} committed`);
    setStatusMessage(
      session.nextAction === "resume"
        ? "Resuming the upload from the last committed byte."
        : "Sending chunks to the governed workspace.",
    );
    setSubmitState("uploading");

    while (offset < file.size) {
      const nextChunk = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      const buffer = await nextChunk.arrayBuffer();
      const response = await fetch(`/api/ingest/sessions/${session.sessionId}/chunk`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-superscriber-byte-start": String(offset),
        },
        body: buffer,
      });

      const { status } = await readJson<{ ok: true; status: UploadSessionStatus }>(response);
      offset = status.bytesReceived;
      setProgressPercent(status.progressPercent);
      setProgressDetail(
        `${formatBytes(status.bytesReceived)} of ${formatBytes(status.bytesExpected)} committed`,
      );
      setStatusMessage(status.verificationSummary || "Upload in progress.");
    }

    setSubmitState("finalizing");
    setStatusMessage("Upload bytes received. Finalizing and starting governed verification.");
    const finalizeResponse = await fetch(
      `/api/ingest/sessions/${session.sessionId}/finalize`,
      {
        method: "POST",
      },
    );
    const { status, nextPath } = await readJson<{
      ok: true;
      status: UploadSessionStatus & { warning?: string | null };
      nextPath: string;
    }>(finalizeResponse);

    clearPendingIngest();
    setProgressPercent(100);
    setProgressDetail(null);
    setSubmitState("idle");
    setResumableNotice(null);

    const query = new URLSearchParams();
    if (status.warning) {
      query.set("error", status.warning);
    } else {
      query.set("notice", "Upload received and queued for governed verification.");
    }

    const destination = query.toString() ? `${nextPath}?${query.toString()}` : nextPath;
    router.push(destination);
    router.refresh();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = selectedFile();
    if (!file) {
      setSubmitState("error");
      setStatusMessage("Attach or record an audio or video file first.");
      return;
    }

    const source = mode;
    setProgressPercent(0);
    setProgressDetail(null);
    setSubmitState("preparing");

    try {
      const pending = readPendingIngest();
      let session: UploadSessionStatus;

      if (pending && fileMatchesPending(file, source, pending)) {
        session = await loadExistingSession(pending.sessionId);
        if (session.nextAction === "restart") {
          clearPendingIngest();
          setStatusMessage(
            session.verificationSummary ||
              "The previous upload session can no longer continue. Starting a new session.",
          );
          session = await createSession(file, source);
        }
      } else {
        session = await createSession(file, source);
      }

      await uploadFile(file, session);
    } catch (error) {
      setSubmitState("resumable");
      setStatusMessage(
        error instanceof Error
          ? `${error.message} Choose the same file again to resume or restart safely.`
          : "Upload interrupted. Choose the same file again to resume safely.",
      );

      const pending = readPendingIngest();
      if (!pending) {
        setSubmitState("error");
      }
    }
  }

  return (
    <section className="panel panel-strong">
      <div className="panel-inner stack">
        <div className="stack-tight">
          <p className="eyebrow">Unified ingest</p>
          <h2 className="section-title">Upload or record into the same governed queue.</h2>
          <p className="body-copy">
            The browser now sends media through a resumable ingest API. Interrupted
            uploads can continue from the last committed byte instead of restarting
            from zero.
          </p>
        </div>

        <form className="form-grid" onSubmit={handleSubmit}>
          <div className="tab-row" role="tablist" aria-label="Choose ingest mode">
            <button
              aria-selected={mode === "upload"}
              className="button button-secondary tab-button"
              data-active={mode === "upload"}
              onClick={() => setMode("upload")}
              role="tab"
              type="button"
            >
              Upload file
            </button>
            <button
              aria-selected={mode === "record"}
              className="button button-secondary tab-button"
              data-active={mode === "record"}
              onClick={() => setMode("record")}
              role="tab"
              type="button"
            >
              Record in browser
            </button>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="recording-title">
              Title
            </label>
            <input
              defaultValue=""
              id="recording-title"
              placeholder="Participant interview 042"
              ref={titleInputRef}
              type="text"
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="recording-language">
              Language hint
            </label>
            <select defaultValue="english" id="recording-language" ref={languageSelectRef}>
              <option value="english">English</option>
              <option value="danish">Danish</option>
              <option value="german">German</option>
              <option value="spanish">Spanish</option>
              <option value="mixed">Mixed / unknown</option>
            </select>
          </div>

          {mode === "upload" ? (
            <div className="field">
              <label className="field-label" htmlFor="upload-file">
                Audio or video file
              </label>
              <input
                accept="audio/*,video/*"
                id="upload-file"
                ref={fileInputRef}
                required={mode === "upload"}
                type="file"
              />
              <p className="field-note">
                The client streams this file to a resumable ingest session under
                <code> data/uploads</code> until final verification begins.
              </p>
            </div>
          ) : (
            <div className="stack">
              <input
                accept="audio/*"
                className="sr-only"
                ref={recordedInputRef}
                type="file"
              />

              <div className="button-row">
                <button
                  className="button button-secondary"
                  disabled={recorderState === "recording" || submitState !== "idle"}
                  onClick={startRecording}
                  type="button"
                >
                  Start recording
                </button>
                <button
                  className="button button-secondary"
                  disabled={recorderState !== "recording"}
                  onClick={stopRecording}
                  type="button"
                >
                  Stop recording
                </button>
                <span className="badge">State: {recorderState}</span>
              </div>

              {previewUrl ? (
                <div className="player-card">
                  <div className="stack-tight">
                    <strong>{recordedFileName ?? "Recorded clip ready"}</strong>
                    <audio controls src={previewUrl} />
                  </div>
                </div>
              ) : null}

              {recorderState === "unsupported" ? (
                <p className="field-note">
                  This browser does not expose the MediaRecorder API.
                </p>
              ) : null}
              {recorderState === "denied" ? (
                <p className="field-note">
                  Microphone access was denied or unavailable.
                </p>
              ) : null}
            </div>
          )}

          <div className="ingest-status-card" aria-live="polite">
            <div className="status-row">
              <strong>Ingest status</strong>
              <span className="badge">{submitState}</span>
            </div>
            <p className="body-copy">{statusMessage}</p>
            {resumableNotice ? <p className="field-note">{resumableNotice}</p> : null}
            <div className="ingest-progress-track" aria-hidden="true">
              <div
                className="ingest-progress-bar"
                style={{
                  width:
                    progressPercent === 0 ? "0%" : `${Math.max(progressPercent, 4)}%`,
                }}
              />
            </div>
            {progressDetail ? <p className="field-note">{progressDetail}</p> : null}
          </div>

          <div className="review-actions">
            <button
              className="button button-primary"
              disabled={
                submitState === "preparing" ||
                submitState === "uploading" ||
                submitState === "finalizing" ||
                (mode === "record" && recorderState !== "ready")
              }
              type="submit"
            >
              {submitState === "preparing"
                ? "Opening ingest session..."
                : submitState === "uploading"
                  ? "Uploading..."
                  : submitState === "finalizing"
                    ? "Finalizing..."
                    : "Send to governed workspace"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
