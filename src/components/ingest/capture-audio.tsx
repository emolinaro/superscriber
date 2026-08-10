"use client";

import { useEffect, useRef, useState } from "react";

export function isBrowserRecordingSupported() {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

type CaptureState = "idle" | "recording" | "paused" | "ready" | "unsupported" | "denied";

const RECORDING_COPY =
  "Recording in progress. Pause to take a break, or Stop when you are ready to upload.";
const PAUSED_COPY =
  "Recording paused. This recording stays in this browser tab; reloading, navigating, or " +
  "switching source starts over. Resume to continue the same recording, or Stop to finish and " +
  "preview the audio already captured.";
const READY_COPY = "Recording stopped. Preview the audio, then choose Upload recording or Discard it.";
const DISCARDED_COPY = "Recording discarded. Start recording to capture a new take.";
const PAUSE_FAULT_COPY =
  "Pause is unavailable for this recording. Stop to finish and preview the audio already captured.";
const RESUME_FAULT_COPY =
  "Resume is unavailable for this recording. Stop to finish and preview the audio already captured.";
const TRACK_ENDED_COPY =
  "The microphone connection ended, so this take cannot continue. Start recording to begin a new take.";

export function CaptureAudio({
  disabled,
  onRecordingReady,
  onRecordingCleared,
}: {
  disabled: boolean;
  onRecordingReady: (file: File) => void;
  onRecordingCleared: () => void;
}) {
  const [captureState, setCaptureState] = useState<CaptureState>(
    isBrowserRecordingSupported() ? "idle" : "unsupported",
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recordedFileName, setRecordedFileName] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [captureControlsFaulted, setCaptureControlsFaulted] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const suppressCompletionRef = useRef(false);

  useEffect(() => {
    if (captureState === "denied") {
      noticeRef.current?.focus();
    }
  }, [captureState]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [previewUrl]);

  useEffect(() => {
    return () => {
      suppressCompletionRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Unmount teardown is best effort; the take is abandoned either way.
        }
      }
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      chunksRef.current = [];
    };
  }, []);

  async function startRecording() {
    if (!isBrowserRecordingSupported()) {
      setCaptureState("unsupported");
      return;
    }

    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      chunksRef.current = [];
      suppressCompletionRef.current = false;
      setCaptureNotice(null);
      setCaptureControlsFaulted(false);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      streamRef.current = stream;

      stream.getTracks().forEach((track) => track.addEventListener("ended", handleTrackEnded));

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener("stop", () => {
        if (suppressCompletionRef.current) {
          return;
        }

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const file = new File([blob], `recording-${Date.now()}.webm`, {
          type: blob.type || "audio/webm",
        });

        setRecordedFileName(file.name);
        setPreviewUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return URL.createObjectURL(blob);
        });
        setCaptureNotice(null);
        setCaptureState("ready");
        stream.getTracks().forEach((track) => track.stop());
        onRecordingReady(file);
      });

      recorder.start();
      setCaptureState("recording");
    } catch {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setCaptureState("denied");
    }
  }

  function pauseRecording() {
    const recorder = recorderRef.current;
    if (captureState !== "recording" || !recorder || recorder.state !== "recording") {
      return;
    }

    try {
      recorder.pause();
      setCaptureState("paused");
    } catch {
      setCaptureControlsFaulted(true);
      setCaptureNotice(PAUSE_FAULT_COPY);
    }
  }

  function resumeRecording() {
    const recorder = recorderRef.current;
    if (captureState !== "paused" || !recorder || recorder.state !== "paused") {
      return;
    }

    try {
      recorder.resume();
      setCaptureState("recording");
    } catch {
      setCaptureControlsFaulted(true);
      setCaptureNotice(RESUME_FAULT_COPY);
    }
  }

  function stopRecording() {
    if (captureState !== "recording" && captureState !== "paused") {
      return;
    }

    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    recorder.stop();
  }

  function discardRecording() {
    setPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
    setRecordedFileName(null);
    setCaptureControlsFaulted(false);
    setCaptureNotice(DISCARDED_COPY);
    setCaptureState(isBrowserRecordingSupported() ? "idle" : "unsupported");
    onRecordingCleared();
  }

  function handleTrackEnded() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    suppressCompletionRef.current = true;
    try {
      recorder.stop();
    } catch {
      // Teardown is best effort; the take is abandoned either way.
    }
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    setCaptureControlsFaulted(false);
    setCaptureNotice(TRACK_ENDED_COPY);
    setCaptureState("idle");
  }

  if (captureState === "unsupported") {
    return (
      <p className="field-note" role="note">
        Browser recording is not available in this browser.
      </p>
    );
  }

  if (captureState === "denied") {
    return (
      <p
        ref={noticeRef}
        aria-live="assertive"
        className="inline-notice"
        data-tone="warning"
        role="alert"
        tabIndex={-1}
      >
        Microphone access was blocked. Choose Upload file to continue safely.
      </p>
    );
  }

  const statusCopy =
    captureNotice ??
    (captureState === "recording"
      ? RECORDING_COPY
      : captureState === "paused"
        ? PAUSED_COPY
        : captureState === "ready"
          ? READY_COPY
          : "");

  return (
    <div className="ingest-capture stack-tight">
      <div className="button-row ingest-capture__actions">
        <button
          className="button button-secondary interactive-target"
          disabled={disabled || captureState !== "idle"}
          onClick={startRecording}
          type="button"
        >
          Start recording
        </button>
        {captureState === "recording" || captureState === "paused" ? (
          <button
            className="button button-secondary interactive-target"
            disabled={disabled || captureControlsFaulted}
            onClick={captureState === "paused" ? resumeRecording : pauseRecording}
            type="button"
          >
            {captureState === "paused" ? "Resume recording" : "Pause recording"}
          </button>
        ) : null}
        <button
          className="button button-secondary interactive-target"
          disabled={
            disabled || (captureState !== "recording" && captureState !== "paused")
          }
          onClick={stopRecording}
          type="button"
        >
          Stop recording
        </button>
        {captureState === "ready" ? (
          <button
            className="button button-secondary interactive-target"
            disabled={disabled}
            onClick={discardRecording}
            type="button"
          >
            Discard
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="field-note" role="status">
        {statusCopy}
      </p>
      {previewUrl ? (
        <div className="player-card ingest-capture__preview">
          <div className="stack-tight">
            <strong>{recordedFileName ?? "Recorded audio"}</strong>
            <audio aria-label="Recorded audio preview" controls src={previewUrl} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
