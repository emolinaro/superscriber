"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { RecordingSource, UserRole } from "@/domain/models";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/error-summary";
import { usePhoneSafetyMode } from "@/components/ui/phone-safety";
import { CaptureAudio, isBrowserRecordingSupported } from "./capture-audio";
import { ModelTierDownloadAction, type TierDownloadView } from "./model-tier-download";
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
const STABLE_UPLOAD_INTERRUPTION_ANNOUNCEMENT = "Upload interrupted.";
const STABLE_UPLOAD_INTERRUPTION_RECOVERY =
  "Upload interrupted. Choose the same file again to resume safely.";
const STORED_UPLOAD_CHECK_MESSAGE = "Superscriber is checking the stored upload.";
const STORED_UPLOAD_CHECK_DETAIL =
  "Superscriber is checking the stored upload. Choose the same file again or reload this page so it can confirm whether verification already started.";

// model-tier-provisioning: while a tier install runs the picker polls the
// admin-provisioning surface at this cadence; the server serializes downloads
// so at most one tier is ever in flight.
const MODEL_DOWNLOAD_POLL_MS = 800;

type FlowState =
  | "idle"
  | "preparing"
  | "uploading"
  | "interrupted"
  | "finalizing"
  // batch finished state; the single-file flow keeps the original set.
  | "complete";

function isDurablyFinalized(status: UploadSessionStatus) {
  return (
    status.nextAction === "none" &&
    (status.integrityState === "verified" || status.integrityState === "verifying" || status.state === "verified")
  );
}

function isInterruptedTransportError(error: unknown) {
  return error instanceof Error && error.name === "TypeError" && error.message === "Failed to fetch";
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
  const [recordingSupported, setRecordingSupported] = useState(false);
  const [source, setSource] = useState<RecordingSource>("upload");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("");
  // demo-model-tier-picker: the catalog is server-checked against actual
  // model artifacts on this host; unprovisioned tiers are disabled and say
  // so explicitly. Default = best-quality provisioned tier.
  const [modelCatalog, setModelCatalog] = useState<{
    tiers: Array<{
      id: string;
      speedNote: string;
      qualityNote: string;
      available: boolean;
      default: boolean;
      downloadSizeBytes: number;
    }>;
    configuredModel: string;
    defaultModel: string | null;
  } | null>(null);
  const [transcriptModel, setTranscriptModel] = useState("");
  // model-tier-provisioning: only admins outside phone-safety mode see (and
  // poll) the install surface; the server re-checks the gate on every start.
  const canProvisionModels = principalRole === "admin" && !phoneSafety;
  const [provisioning, setProvisioning] = useState<Record<string, TierDownloadView> | null>(
    null,
  );
  const [downloadStartErrors, setDownloadStartErrors] = useState<Record<string, string>>({});
  // The picker accepts a batch; uploadFile stays the primary file so the
  // single-file path is byte-identical to before.
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [batchState, setBatchState] = useState<
    Array<{ name: string; state: "waiting" | "uploading" | "queued" | "failed"; note: string }> | null
  >(null);
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
  const observedInFlightRef = useRef<Set<string>>(new Set());
  const transcriptModelTouchedRef = useRef(false);

  // demo-model-tier-picker: the catalog loads lazily on FIRST expansion of
  // Advanced settings (not on mount) - no network chatter for ignored UI,
  // and test doubles interacting with the upload lane keep their call order.
  const modelCatalogRequestedRef = useRef(false);

  const refreshProvisioning = useCallback(async () => {
    if (!canProvisionModels) {
      return;
    }
    try {
      const response = await fetch("/api/models/provisioning", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as {
        tiers: Array<{ tierId: string; download: TierDownloadView }>;
      };
      const next = Object.fromEntries(body.tiers.map((tier) => [tier.tierId, tier.download]));
      setProvisioning(next);
    } catch {
      // Status refreshes are best-effort; the next poll retries.
    }
  }, [canProvisionModels]);

  const fetchModelCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/models/catalog", { cache: "no-store" });
      const catalog = response.ok ? await response.json() : null;
      if (!catalog) {
        return;
      }
      setModelCatalog(catalog);
      setTranscriptModel((current) => {
        return transcriptModelTouchedRef.current ? current : catalog.defaultModel ?? "";
      });
      void refreshProvisioning();
    } catch {
      // The picker stays disabled without a catalog; an honest empty state.
    }
  }, [refreshProvisioning]);

  const loadModelCatalog = useCallback(() => {
    if (modelCatalogRequestedRef.current) {
      return;
    }
    modelCatalogRequestedRef.current = true;
    void fetchModelCatalog();
  }, [fetchModelCatalog]);

  const activeDownloadTierId = provisioning
    ? (Object.entries(provisioning).find(([, view]) => view.state === "downloading")?.[0] ??
      null)
    : null;

  // Poll the install surface while a download runs.
  useEffect(() => {
    if (!activeDownloadTierId) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshProvisioning();
    }, MODEL_DOWNLOAD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activeDownloadTierId, refreshProvisioning]);

  // When an install this session OBSERVED in flight finishes, re-pull the
  // catalog: host truth has changed, so the tier flips selectable (and the
  // best-available default is recomputed server-side) without a page reload.
  // Tracking the downloading -> completed transition (instead of the raw
  // "completed" state) keeps tiers that were already provisioned when the
  // page loaded - and stale registry states reconciled against missing
  // artifacts - from triggering redundant or missing fetches.
  useEffect(() => {
    if (!provisioning) {
      return;
    }
    for (const [tierId, view] of Object.entries(provisioning)) {
      if (view.state === "downloading") {
        observedInFlightRef.current.add(tierId);
      } else if (view.state === "completed" && observedInFlightRef.current.has(tierId)) {
        observedInFlightRef.current.delete(tierId);
        void fetchModelCatalog();
      }
    }
  }, [provisioning, fetchModelCatalog]);

  async function startModelDownload(tierId: string) {
    setDownloadStartErrors((current) => {
      const next = { ...current };
      delete next[tierId];
      return next;
    });
    try {
      const response = await fetch("/api/models/provisioning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tierId }),
      });
      const parsed = (await response.json().catch(() => null)) as {
        message?: string;
        error?: string;
        status?: TierDownloadView;
      } | null;
      if (!response.ok) {
        throw new Error(parsed?.message || parsed?.error || "The download could not be started.");
      }
      if (parsed?.status) {
        const status = parsed.status;
        setProvisioning((current) => ({ ...(current ?? {}), [tierId]: status }));
      }
      await refreshProvisioning();
    } catch (error) {
      setDownloadStartErrors((current) => ({
        ...current,
        [tierId]:
          error instanceof Error ? error.message : "The download could not be started.",
      }));
    }
  }

  useEffect(() => {
    setRecordingSupported(isBrowserRecordingSupported());
  }, []);

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
    if (source === "upload" && uploadFiles.length === 0 && !uploadFile) {
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
        transcriptModel: transcriptModel || null,
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

  async function transferFileOnce(file: File, titleOverride: string) {
    const response = await fetch("/api/ingest/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: titleOverride,
        languageHint: language,
        source,
        fileName: file.name,
        mimeType: file.type,
        transcriptModel: transcriptModel || null,
        fileSize: file.size,
      }),
    });
    const { status } = await readJson<{ ok: true; status: UploadSessionStatus }>(response);

    let offset = status.nextAction === "finalize" ? status.bytesExpected : status.bytesReceived;
    setProgress({ bytesExpected: status.bytesExpected, bytesReceived: offset });
    while (offset < file.size) {
      const chunkEnd = Math.min(offset + CHUNK_SIZE, file.size);
      const chunkResponse = await fetch(`/api/ingest/sessions/${status.sessionId}/chunk`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-superscriber-byte-start": String(offset),
        },
        body: await file.slice(offset, chunkEnd).arrayBuffer(),
      });
      const { status: nextStatus } = await readJson<{ ok: true; status: UploadSessionStatus }>(
        chunkResponse,
      );
      offset = nextStatus.bytesReceived;
      setProgress({
        bytesExpected: nextStatus.bytesExpected,
        bytesReceived: offset,
      });
      announceProgress(nextStatus.progressPercent);
    }

    const finalize = await fetch(`/api/ingest/sessions/${status.sessionId}/finalize`, {
      method: "POST",
    });
    await readJson<{ ok: true; status: UploadSessionStatus }>(finalize);
  }

  function batchTitleOf(file: File) {
    const stem = file.name.replace(/\.[^.]*$/, "").trim();
    return stem || file.name;
  }

  async function runBatchUpload(files: File[]) {
    setErrors({});
    resetAnnouncements();
    setProgress(null);
    setFlowState("uploading");
    setBatchState(
      files.map((file) => ({ name: file.name, state: "waiting", note: "Waiting" })),
    );

    let failed = 0;
    for (let index = 0; index < files.length; index += 1) {
      const target = files[index];
      const position = index + 1;
      setStatusMessage(`Batch ${position} of ${files.length}: uploading ${target.name}.`);
      setAnnouncement(`Batch ${position} of ${files.length}: ${target.name}.`);
      setBatchState((current) =>
        current?.map((item, itemIndex) =>
          itemIndex === index ? { ...item, state: "uploading", note: "Uploading" } : item,
        ) ?? null,
      );
      try {
        await transferFileOnce(target, batchTitleOf(target));
        setBatchState((current) =>
          current?.map((item, itemIndex) =>
            itemIndex === index ? { ...item, state: "queued", note: "Queued for transcription" } : item,
          ) ?? null,
        );
      } catch (error) {
        failed += 1;
        setBatchState((current) =>
          current?.map((item, itemIndex) =>
            itemIndex === index
              ? {
                  ...item,
                  state: "failed",
                  note:
                    error instanceof Error
                      ? error.message
                      : "Upload failed; the rest of the batch continues.",
                }
              : item,
          ) ?? null,
        );
      }
    }

    clearPendingIngest();
    setResumeNotice(null);
    setUploadFiles([]);
    setUploadFile(null);
    setFlowState("complete");
    setStatusMessage(
      failed > 0
        ? `Batch finished with ${failed} failed of ${files.length}; the rest are queued for transcription.`
        : `Batch complete: ${files.length} recordings queued for transcription.`,
    );
    setAnnouncement(
      failed > 0
        ? `Batch finished with ${failed} failed of ${files.length}.`
        : `Batch complete: ${files.length} recordings queued.`,
    );
    // Keep the file input in sync with the cleared selection so picking the
    // same batch again fires a fresh change event.
    const input = document.getElementById("upload-file");
    if (input instanceof HTMLInputElement) {
      input.value = "";
    }
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

    // Several files queue sequentially; each outcome is independent - one
    // failure never swallows the rest.
    if (source === "upload" && uploadFiles.length > 1) {
      void runBatchUpload(uploadFiles);
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
      const interrupted = isInterruptedTransportError(error);
      const statusMessage = interrupted
        ? STABLE_UPLOAD_INTERRUPTION_RECOVERY
        : error instanceof Error
          ? error.message
          : STABLE_UPLOAD_INTERRUPTION_RECOVERY;

      setFlowState("interrupted");
      setAnnouncement(STABLE_UPLOAD_INTERRUPTION_ANNOUNCEMENT);
      setStatusMessage(statusMessage);
      if (interrupted) {
        setResumeNotice({ tone: "info", message: STABLE_UPLOAD_INTERRUPTION_RECOVERY });
      }
    }
  }

  const transferBusy =
    flowState === "preparing" || flowState === "uploading" || flowState === "finalizing";
  const transferStatusLabel =
    flowState === "uploading"
      ? "Uploading"
      : flowState === "finalizing"
        ? "Finalizing"
        : flowState === "preparing"
          ? "Preparing"
          : flowState === "interrupted"
            ? "Interrupted"
            : flowState === "complete"
              ? "Complete"
              : "Idle";

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
            disabled={transferBusy}
            onChange={(nextSource) => {
              setSource(nextSource);
              if (nextSource !== "record") {
                setRecordedFile(null);
              }
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

          <details
            className="ingest-advanced"
            data-testid="advanced-settings"
            onToggle={(event) => {
              if ((event.target as HTMLDetailsElement).open) {
                loadModelCatalog();
              }
            }}
          >
            <summary className="ingest-advanced__toggle">Advanced settings</summary>
            <div className="field ingest-advanced__field">
              <label className="field-label" htmlFor="recording-model">
                Transcription model
              </label>
              <select
                aria-describedby="recording-model-note"
                disabled={!modelCatalog}
                id="recording-model"
                onChange={(event) => {
                  transcriptModelTouchedRef.current = true;
                  setTranscriptModel(event.target.value);
                }}
                value={transcriptModel}
              >
                {!modelCatalog ? <option value="">Checking available models...</option> : null}
                {modelCatalog && !modelCatalog.defaultModel ? (
                  <option value="">No provisioned models available</option>
                ) : null}
                {modelCatalog
                  ? modelCatalog.tiers.map((tier) => (
                      <option
                        disabled={!tier.available}
                        key={tier.id}
                        value={tier.id}
                      >
                        {tier.id}
                        {tier.default ? " - default" : ""}
                        {!tier.available ? " - not available on this host" : ""}
                      </option>
                    ))
                  : null}
              </select>
              {modelCatalog ? (
                <ul className="ingest-model-notes" aria-label="Model speed and quality notes">
                  {modelCatalog.tiers.map((tier) => (
                    <li key={tier.id}>
                      <strong>{tier.id}</strong>: {tier.qualityNote} · {tier.speedNote}
                      {tier.available ? "" : " - not provisioned here"}
                      {!tier.available && canProvisionModels ? (
                        <ModelTierDownloadAction
                          tierId={tier.id}
                          sizeBytes={tier.downloadSizeBytes}
                          view={provisioning?.[tier.id] ?? null}
                          startError={downloadStartErrors[tier.id] ?? null}
                          busy={activeDownloadTierId !== null}
                          onStart={() => void startModelDownload(tier.id)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="field-note" id="recording-model-note">
                The selected model is requested for this recording. If it cannot run, the worker
                falls back to the configured default or stub engine and discloses that in the
                revision summary.
              </p>
              {modelCatalog ? (
                <p className="field-note">Configured worker model: {modelCatalog.configuredModel}.</p>
              ) : null}
            </div>
          </details>

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
                  disabled={transferBusy}
                  id="upload-file"
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    setUploadFiles(files);
                    setUploadFile(files[0] ?? null);
                    setBatchState(null);
                  }}
                  type="file"
                />
                <p className="field-note" id="upload-file-note">
                  Select one file - or a whole batch. The browser sends each file in 1 MiB chunks;
                  single files can resume from the last committed byte, batches run sequentially
                  with per-file results.
                </p>
                {uploadFiles.length > 1 ? (
                  <p className="field-note" data-testid="batch-count">
                    {uploadFiles.length} files selected.
                  </p>
                ) : null}
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
                  disabled={transferBusy}
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

            {batchState ? (
              <section
                aria-label="Batch results"
                className="ingest-batch"
                data-testid="batch-results"
              >
                <h3 className="ingest-section__title">Batch results</h3>
                <ol className="ingest-batch__list">
                  {batchState.map((item, index) => (
                    <li className="ingest-batch__item" data-state={item.state} key={index}>
                      <span className="ingest-batch__name">{item.name}</span>
                      <span className="ingest-batch__note">{item.note}</span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <section className="ingest-status-card" aria-live="polite">
              <div className="status-row">
                <strong>Status</strong>
                <span className="badge">{flowState}</span>
              </div>
              <p className="body-copy">{statusMessage}</p>
              {/* The transfer surface is persistent: it shows an honest idle
                  state between transfers and live committed bytes during one,
                  so the control never blinks out of existence on fast
                  transfers. */}
              <TransferProgress
                announcement={announcement}
                bytesExpected={progress?.bytesExpected ?? 0}
                bytesReceived={progress?.bytesReceived ?? 0}
                detail={progress ? undefined : "No transfer in progress."}
                statusLabel={transferStatusLabel}
              />
            </section>
          </section>

          <div className="review-actions ingest-actions">
            {/* The submit control is persistent too: it only relabels and
                disables while a transfer runs, instead of swapping out. */}
            <button
              className="button button-primary interactive-target"
              disabled={transferBusy}
              type="submit"
            >
              {transferBusy
                ? flowState === "finalizing"
                  ? "Finalizing upload..."
                  : "Uploading..."
                : uploadLabelForSource(source)}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
