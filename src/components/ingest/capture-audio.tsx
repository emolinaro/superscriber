"use client";

import { useEffect, useRef, useState } from "react";

export function isBrowserRecordingSupported() {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

export function CaptureAudio({
  disabled,
  onRecordingReady,
  onRecordingCleared,
}: {
  disabled: boolean;
  onRecordingReady: (file: File) => void;
  onRecordingCleared: () => void;
}) {
  const [captureState, setCaptureState] = useState<
    "idle" | "recording" | "ready" | "unsupported" | "denied"
  >(isBrowserRecordingSupported() ? "idle" : "unsupported");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recordedFileName, setRecordedFileName] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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

  async function startRecording() {
    if (!isBrowserRecordingSupported()) {
      setCaptureState("unsupported");
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
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener("stop", () => {
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

  function stopRecording() {
    if (!recorderRef.current || recorderRef.current.state === "inactive") {
      return;
    }

    recorderRef.current.stop();
  }

  function replaceRecording() {
    setPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
    setRecordedFileName(null);
    setCaptureState(isBrowserRecordingSupported() ? "idle" : "unsupported");
    onRecordingCleared();
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

  return (
    <div className="ingest-capture stack-tight">
      <div className="button-row ingest-capture__actions">
        <button
          className="button button-secondary interactive-target"
          disabled={disabled || captureState === "recording"}
          onClick={startRecording}
          type="button"
        >
          Start recording
        </button>
        <button
          className="button button-secondary interactive-target"
          disabled={captureState !== "recording"}
          onClick={stopRecording}
          type="button"
        >
          Stop recording
        </button>
        {captureState === "ready" ? (
          <button
            className="button button-secondary interactive-target"
            disabled={disabled}
            onClick={replaceRecording}
            type="button"
          >
            Replace recording
          </button>
        ) : null}
      </div>
      {captureState === "recording" ? (
        <p className="field-note">Recording in progress. Stop when you are ready to upload.</p>
      ) : null}
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
