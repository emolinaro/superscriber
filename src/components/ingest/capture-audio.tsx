"use client";

import { useEffect, useRef, useState } from "react";

export function isBrowserRecordingSupported() {
  if (typeof window === "undefined") {
    return false;
  }

  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

type CaptureState = "idle" | "recording" | "paused" | "ready" | "unsupported" | "denied";

type CaptureGeneration = {
  active: boolean;
  chunks: Blob[];
  dataAvailableListener: ((event: BlobEvent) => void) | null;
  recorder: MediaRecorder | null;
  stopListener: (() => void) | null;
  stopRequested: boolean;
  stream: MediaStream | null;
  trackEndedListeners: Array<{ listener: () => void; track: MediaStreamTrack }>;
};

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
  const [isStarting, setIsStarting] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const captureRef = useRef<CaptureGeneration | null>(null);

  function releaseCapture(capture: CaptureGeneration, stopRecorder = true) {
    capture.active = false;
    if (captureRef.current === capture) {
      captureRef.current = null;
    }

    const recorder = capture.recorder;
    if (recorder && capture.dataAvailableListener) {
      recorder.removeEventListener("dataavailable", capture.dataAvailableListener);
    }
    if (recorder && capture.stopListener) {
      recorder.removeEventListener("stop", capture.stopListener);
    }
    capture.trackEndedListeners.forEach(({ listener, track }) => {
      track.removeEventListener("ended", listener);
    });

    if (stopRecorder && recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        capture.stopRequested = false;
      }
    }
    capture.stream?.getTracks().forEach((track) => track.stop());
    capture.chunks.length = 0;
    capture.dataAvailableListener = null;
    capture.recorder = null;
    capture.stopListener = null;
    capture.stream = null;
    capture.trackEndedListeners = [];
  }

  function abandonInterruptedCapture(capture: CaptureGeneration) {
    if (!capture.active || captureRef.current !== capture) {
      return;
    }

    releaseCapture(capture);
    setIsStarting(false);
    setCaptureControlsFaulted(false);
    setCaptureNotice(TRACK_ENDED_COPY);
    setCaptureState("idle");
  }

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
    };
  }, [previewUrl]);

  useEffect(() => {
    return () => {
      const capture = captureRef.current;
      if (capture) {
        releaseCapture(capture);
      }
    };
  }, []);

  async function startRecording() {
    if (!isBrowserRecordingSupported()) {
      setCaptureState("unsupported");
      return;
    }

    if (captureState !== "idle" || captureRef.current) {
      return;
    }

    const capture: CaptureGeneration = {
      active: true,
      chunks: [],
      dataAvailableListener: null,
      recorder: null,
      stopListener: null,
      stopRequested: false,
      stream: null,
      trackEndedListeners: [],
    };
    captureRef.current = capture;
    setIsStarting(true);
    setCaptureNotice(null);
    setCaptureControlsFaulted(false);

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!capture.active || captureRef.current !== capture) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const recorder = new MediaRecorder(stream);
      capture.recorder = recorder;
      capture.stream = stream;

      capture.trackEndedListeners = stream.getTracks().map((track) => {
        const listener = () => {
          if (!capture.stopRequested) {
            abandonInterruptedCapture(capture);
          }
        };
        track.addEventListener("ended", listener);
        return { listener, track };
      });

      capture.dataAvailableListener = (event) => {
        if (
          capture.active &&
          captureRef.current === capture &&
          event.data &&
          event.data.size > 0
        ) {
          capture.chunks.push(event.data);
        }
      };

      capture.stopListener = () => {
        if (!capture.active || captureRef.current !== capture) {
          return;
        }

        if (!capture.stopRequested) {
          abandonInterruptedCapture(capture);
          return;
        }

        const blob = new Blob(capture.chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        const file = new File([blob], `recording-${Date.now()}.webm`, {
          type: blob.type || "audio/webm",
        });

        releaseCapture(capture, false);
        setRecordedFileName(file.name);
        setPreviewUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return URL.createObjectURL(blob);
        });
        setCaptureNotice(null);
        setCaptureState("ready");
        onRecordingReady(file);
      };

      recorder.addEventListener("dataavailable", capture.dataAvailableListener);
      recorder.addEventListener("stop", capture.stopListener);

      recorder.start();
      setIsStarting(false);
      setCaptureState("recording");
    } catch {
      if (!capture.active || captureRef.current !== capture) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }

      if (stream && !capture.stream) {
        capture.stream = stream;
      }
      releaseCapture(capture);
      setIsStarting(false);
      setCaptureState("denied");
    }
  }

  function pauseRecording() {
    const recorder = captureRef.current?.recorder;
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
    const recorder = captureRef.current?.recorder;
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

    const capture = captureRef.current;
    const recorder = capture?.recorder;
    if (!capture || !recorder || recorder.state === "inactive") {
      return;
    }

    capture.stopRequested = true;
    recorder.stop();
  }

  function discardRecording() {
    const capture = captureRef.current;
    if (capture) {
      releaseCapture(capture);
    }
    setPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return null;
    });
    setRecordedFileName(null);
    setIsStarting(false);
    setCaptureControlsFaulted(false);
    setCaptureNotice(DISCARDED_COPY);
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
          disabled={disabled || captureState !== "idle" || isStarting}
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
