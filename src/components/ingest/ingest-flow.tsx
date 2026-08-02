"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { RecordingSource, UserRole } from "@/domain/models";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/error-summary";
import { usePhoneSafetyMode } from "@/components/ui/phone-safety";
import { CaptureAudio, isBrowserRecordingSupported } from "./capture-audio";
import {
  CHUNK_SIZE,
  clearPendingIngest,
  fileMatchesPending,
  readPendingIngest,
  type UploadSessionStatus,
  writePendingIngest,
} from "./resumable-upload";
import { ResumeUploadCard } from "./resume-upload-card";
import { SourceChoice } from "./source-choice";
import { nextProgressAnnouncement, TransferProgress } from "./transfer-progress";

const TITLE_ERROR_MESSAGE = "Enter a title between 1 and 120 characters.";
const LANGUAGE_ERROR_MESSAGE = "Choose a language.";
const FILE_ERROR_MESSAGE = "Choose a file to upload.";
const RECORDING_ERROR_MESSAGE = "Record audio before uploading.";
const SUCCESS_NOTICE = "Upload received. Verification has started.";
const STORED_UPLOAD_CHECK_MESSAGE = "Superscriber is checking the stored upload.";
const STORED_UPLOAD_CHECK_DETAIL =
  "Superscriber is checking the stored upload. Choose the same file again or reload this page so it can confirm whether verification already started.";

type FlowState = "idle" | "preparing" | "uploading" | "interrupted" | "finalizing";

function isDurablyFinalized(status: UploadSessionStatus) {
  return (
    status.nextAction === "none" &&
    (status.integrityState === "verified" || status.integrityState === "verifying" || status.state === "verified")
  );
}

function uploadLabelForSource(source: RecordingSource) {
  return source === "record" ? "Upload recording" : "Upload file";
}

async function readJson<T>(response: Response) {
  const parsed = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok || parsed.ok === false) {
    throw new Error(parsed.error || "The request failed.");
  }

  return parsed;
}

export function IngestFlow({
  principalRole,
}: {
  principalRole: Extract<UserRole, "uploader" | "admin">;
}) {
  const router = useRouter();
  const phoneSafety = usePhoneSafetyMode();
  const recordingSupported = useMemo(() => isBrowserRecordingSupported(), []);
  const [source, setSource] = useState<RecordingSource>("upload");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [recordedFile, setRecordedFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "Choose a source, add details, and start a governed upload.",
  );
  const [announcement, setAnnouncement] = useState("");
  const [progress, setProgress] = useState<{ bytesExpected: number; bytesReceived: number } | null>(
    null,
  );
  const [resumeNotice, setResumeNotice] = useState<{
    tone: "info" | "warning";
    message: string;
  } | null>(null);
  const boundaryRef = useRef(-1);

  useEffect(() => {
    if (!recordingSupported && source === "record") {
      setSource("upload");
    }
  }, [recordingSupported, source]);

  useEffect(() => {
    const pending = readPendingIngest();
    if (!pending) {
      return;
    }

    void refreshPendingNotice(pending.sessionId, pending.fileName);
  }, []);

  function resetAnnouncements() {
    boundaryRef.current = -1;
    setAnnouncement("");
  }

  function finishDurableUpload(status: UploadSessionStatus) {
    clearPendingIngest();
    setResumeNotice(null);
    const query = new URLSearchParams();
    if (status.warning) {
      query.set("error", status.warning);
    } else {
      query.set("notice", SUCCESS_NOTICE);
    }

    const destination =
      principalRole === "admin" ? `/recordings/${status.recordingId}` : "/workspace";
    router.push(`${destination}?${query.toString()}`);
    router.refresh();
  }

  function showStoredUploadChecking() {
    setFlowState("interrupted");
    setAnnouncement(STORED_UPLOAD_CHECK_MESSAGE);
    setStatusMessage(STORED_UPLOAD_CHECK_MESSAGE);
    setResumeNotice({ tone: "info", message: STORED_UPLOAD_CHECK_DETAIL });
  }

  async function refreshPendingNotice(sessionId: string, fileName: string) {
    try {
      const response = await fetch(`/api/ingest/sessions/${sessionId}`, {
        cache: "no-store",
      });
      const { status } = await readJson<{ ok: true; status: UploadSessionStatus }>(response);

      if (status.nextAction === "resume") {
        setResumeNotice({
          tone: "info",
          message: `Resume upload for ${fileName} from ${status.bytesReceived} B committed.`,
        });
        return status;
      }

      if (status.nextAction === "finalize") {
        setResumeNotice({
          tone: "info",
          message: `Upload bytes for ${fileName} are already committed. Choose the same file to finish verification.`,
        });
        return status;
      }

      if (status.nextAction === "restart") {
        clearPendingIngest();
        setResumeNotice({
          tone: "warning",
          message:
            status.verificationSummary ||
            "The previous upload can no longer continue. Start a new upload.",
        });
        return status;
      }

      if (isDurablyFinalized(status)) {
        finishDurableUpload(status);
        return status;
      }

      showStoredUploadChecking();
      return status;
    } catch {
      showStoredUploadChecking();
      return null;
    }
  }

  function buildErrors() {
    const nextErrors: Record<string, string> = {};
    const trimmedTitle = title.trim();

    if (trimmedTitle.length < 1 || trimmedTitle.length > 120) {
      nextErrors.title = TITLE_ERROR_MESSAGE;
    }
    if (!language) {
      nextErrors.language = LANGUAGE_ERROR_MESSAGE;
    }
    if (source === "upload" && !uploadFile) {
      nextErrors.file = FILE_ERROR_MESSAGE;
    }
    if (source === "record" && !recordedFile) {
      nextErrors.recording = RECORDING_ERROR_MESSAGE;
    }

    return nextErrors;
  }

  const summaryErrors: ErrorSummaryItem[] = [];
  if (errors.title) {
    summaryErrors.push({ fieldId: "recording-title", label: "Title", message: errors.title });
  }
  if (errors.language) {
    summaryErrors.push({
      fieldId: "recording-language",
      label: "Language",
      message: errors.language,
    });
  }
  if (errors.file) {
    summaryErrors.push({ fieldId: "upload-file", label: "File", message: errors.file });
  }
  if (errors.recording) {
    summaryErrors.push({
      fieldId: "recording-capture",
      label: "Recording",
      message: errors.recording,
    });
  }

  function announceProgress(progressPercent: number) {
    const next = nextProgressAnnouncement(boundaryRef.current, progressPercent);
    if (!next) {
      return;
    }

    boundaryRef.current = next.boundary;
    setAnnouncement(next.message);
  }

  async function createSession(file: File, selectedSource: RecordingSource) {
    const response = await fetch("/api/ingest/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: title.trim(),
        languageHint: language,
        source: selectedSource,
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
      source: selectedSource,
    });
    return status;
  }

  async function loadSession(sessionId: string) {
    const response = await fetch(`/api/ingest/sessions/${sessionId}`, {
      cache: "no-store",
    });
    const { status } = await readJson<{ ok: true; status: UploadSessionStatus }>(response);
    return status;
  }

  async function reconcileFinalizeResponseLoss(session: UploadSessionStatus) {
    try {
      const status = await loadSession(session.sessionId);

      if (status.nextAction === "restart") {
        const message =
          status.verificationSummary ||
          "The previous upload can no longer continue. Start a new upload.";
        clearPendingIngest();
        setFlowState("interrupted");
        setAnnouncement(message);
        setStatusMessage(message);
        setResumeNotice({ tone: "warning", message });
        return;
      }

      if (isDurablyFinalized(status)) {
        finishDurableUpload(status);
        return;
      }
    } catch {
      // Fall through to the safe checking copy below.
    }

    showStoredUploadChecking();
  }

  async function finalizeUpload(session: UploadSessionStatus) {
    setFlowState("finalizing");
    setStatusMessage("Upload complete. Finalizing verification.");
    setAnnouncement("Finalizing upload.");

    try {
      const response = await fetch(`/api/ingest/sessions/${session.sessionId}/finalize`, {
        method: "POST",
      });
      const { status } = await readJson<{
        ok: true;
        status: UploadSessionStatus;
        nextPath: string;
      }>(response);

      finishDurableUpload(status);
    } catch {
      await reconcileFinalizeResponseLoss(session);
    }
  }

  async function uploadChunks(file: File, session: UploadSessionStatus) {
    let offset = session.bytesReceived;
    setFlowState("uploading");
    setStatusMessage(
      offset > 0 ? "Resuming upload from the last committed byte." : "Uploading file.",
    );
    setProgress({
      bytesExpected: session.bytesExpected,
      bytesReceived: session.bytesReceived,
    });
    announceProgress(session.progressPercent);

    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      const response = await fetch(`/api/ingest/sessions/${session.sessionId}/chunk`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-superscriber-byte-start": String(offset),
        },
        body: await chunk.arrayBuffer(),
      });
      const { status } = await readJson<{ ok: true; status: UploadSessionStatus }>(response);
      offset = status.bytesReceived;
      setProgress({
        bytesExpected: status.bytesExpected,
        bytesReceived: status.bytesReceived,
      });
      setStatusMessage(status.verificationSummary || "Uploading file.");
      announceProgress(status.progressPercent);
    }

    await finalizeUpload({
      ...session,
      bytesReceived: file.size,
      bytesExpected: file.size,
      progressPercent: 100,
      nextAction: "finalize",
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = buildErrors();
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setFlowState("idle");
      setStatusMessage("Fix the highlighted fields and try again.");
      setAnnouncement("Fix the highlighted fields and try again.");
      return;
    }

    const file = source === "record" ? recordedFile : uploadFile;
    if (!file) {
      return;
    }

    resetAnnouncements();
    setProgress(null);
    setFlowState("preparing");
    setStatusMessage("Preparing upload session.");

    try {
      let session: UploadSessionStatus;
      const pending = readPendingIngest();

      if (pending && fileMatchesPending(file, source, pending)) {
        session = await loadSession(pending.sessionId);

        if (session.nextAction === "restart") {
          clearPendingIngest();
          setResumeNotice({
            tone: "warning",
            message:
              session.verificationSummary ||
              "The previous upload can no longer continue. Start a new upload.",
          });
          session = await createSession(file, source);
        }
      } else {
        session = await createSession(file, source);
      }

      if (isDurablyFinalized(session)) {
        finishDurableUpload(session);
        return;
      }

      if (session.nextAction === "finalize") {
        await finalizeUpload(session);
        return;
      }

      await uploadChunks(file, session);
    } catch (error) {
      setFlowState("interrupted");
      setAnnouncement("Upload interrupted.");
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Upload interrupted. Choose the same file again to resume safely.",
      );
    }
  }

  const showTransfer = flowState === "uploading" || flowState === "finalizing";

  return (
    <section className="panel panel-strong">
      <div className={`panel-inner stack ingest-flow ${phoneSafety ? "ingest-flow--compact" : ""}`}>
        <div className="stack-tight">
          <p className="eyebrow">Focused ingest</p>
          <h2 className="section-title">Source, details, and transfer in one accessible flow.</h2>
          <p className="body-copy">
            Upload a file or record audio in the browser, then resume safely from the last
            committed byte if the transfer is interrupted.
          </p>
        </div>

        <ErrorSummary errors={summaryErrors} />
        {resumeNotice ? <ResumeUploadCard message={resumeNotice.message} tone={resumeNotice.tone} /> : null}

        <form className="ingest-form" onSubmit={handleSubmit}>
          <SourceChoice
            onChange={(nextSource) => {
              setSource(nextSource);
              setErrors((current) => {
                const next = { ...current };
                delete next.file;
                delete next.recording;
                return next;
              });
            }}
            recordingSupported={recordingSupported}
            source={source}
          />

          <section className="ingest-section stack-tight">
            <h3 className="ingest-section__title">Details</h3>
            <div className="form-grid">
              <div className="field">
                <label className="field-label" htmlFor="recording-title">
                  Title
                </label>
                <input
                  aria-describedby={errors.title ? "recording-title-error" : undefined}
                  aria-invalid={errors.title ? "true" : "false"}
                  className="interactive-target"
                  id="recording-title"
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Participant interview 042"
                  type="text"
                  value={title}
                />
                {errors.title ? (
                  <p className="field-error-message" id="recording-title-error">
                    {errors.title}
                  </p>
                ) : null}
              </div>

              <div className="field">
                <label className="field-label" htmlFor="recording-language">
                  Language
                </label>
                <select
                  aria-describedby={errors.language ? "recording-language-error" : undefined}
                  aria-invalid={errors.language ? "true" : "false"}
                  className="interactive-target"
                  id="recording-language"
                  onChange={(event) => setLanguage(event.target.value)}
                  value={language}
                >
                  <option value="">Choose a language</option>
                  <option value="english">English</option>
                  <option value="danish">Danish</option>
                  <option value="german">German</option>
                  <option value="spanish">Spanish</option>
                  <option value="mixed">Mixed / unknown</option>
                </select>
                {errors.language ? (
                  <p className="field-error-message" id="recording-language-error">
                    {errors.language}
                  </p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="ingest-section stack-tight">
            <h3 className="ingest-section__title">Transfer</h3>
            {source === "upload" ? (
              <div className="field">
                <label className="field-label" htmlFor="upload-file">
                  Audio or video file
                </label>
                <input
                  accept="audio/*,video/*"
                  aria-describedby={errors.file ? "upload-file-error" : "upload-file-note"}
                  aria-invalid={errors.file ? "true" : "false"}
                  className="interactive-target"
                  id="upload-file"
                  onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                <p className="field-note" id="upload-file-note">
                  The browser sends this file in 1 MiB chunks and can resume from the last
                  committed byte.
                </p>
                {errors.file ? (
                  <p className="field-error-message" id="upload-file-error">
                    {errors.file}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="field" id="recording-capture">
                <p className="field-label">Record audio</p>
                <CaptureAudio
                  disabled={flowState !== "idle"}
                  onRecordingCleared={() => setRecordedFile(null)}
                  onRecordingReady={(file) => setRecordedFile(file)}
                />
                {errors.recording ? (
                  <p className="field-error-message" id="recording-capture-error">
                    {errors.recording}
                  </p>
                ) : null}
              </div>
            )}

            <section className="ingest-status-card" aria-live="polite">
              <div className="status-row">
                <strong>Status</strong>
                <span className="badge">{flowState}</span>
              </div>
              <p className="body-copy">{statusMessage}</p>
              {showTransfer && progress ? (
                <TransferProgress
                  announcement={announcement}
                  bytesExpected={progress.bytesExpected}
                  bytesReceived={progress.bytesReceived}
                  statusLabel={flowState === "finalizing" ? "Finalizing" : "Uploading"}
                />
              ) : null}
            </section>
          </section>

          <div className="review-actions ingest-actions">
            {showTransfer ? (
              <p aria-live="polite" className="badge" role="status">
                {flowState === "finalizing" ? "Finalizing upload" : "Uploading in progress"}
              </p>
            ) : (
              <button className="button button-primary interactive-target" type="submit">
                {uploadLabelForSource(source)}
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
