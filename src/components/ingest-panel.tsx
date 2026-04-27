"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

type IngestAction = (formData: FormData) => void | Promise<void>;

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      className="button button-primary"
      disabled={disabled || pending}
      type="submit"
    >
      {pending ? "Sending to governed workspace..." : "Send to governed workspace"}
    </button>
  );
}

export function IngestPanel({ action }: { action: IngestAction }) {
  const [mode, setMode] = useState<"upload" | "record">("upload");
  const [recorderState, setRecorderState] = useState<
    "idle" | "recording" | "ready" | "unsupported" | "denied"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recordedFileName, setRecordedFileName] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recordedInputRef = useRef<HTMLInputElement | null>(null);

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

  return (
    <section className="panel panel-strong">
      <div className="panel-inner stack">
        <div className="stack-tight">
          <p className="eyebrow">Unified ingest</p>
          <h2 className="section-title">Upload or record into the same governed queue.</h2>
          <p className="body-copy">
            The browser never stores these files persistently. This client component only
            holds recording data in memory until it is posted to the server action.
          </p>
        </div>

        <form action={action} className="form-grid">
          <div className="tab-row">
            <button
              className="button button-secondary tab-button"
              data-active={mode === "upload"}
              onClick={() => setMode("upload")}
              type="button"
            >
              Upload file
            </button>
            <button
              className="button button-secondary tab-button"
              data-active={mode === "record"}
              onClick={() => setMode("record")}
              type="button"
            >
              Record in browser
            </button>
          </div>

          <input type="hidden" name="source" value={mode} />

          <div className="field">
            <label className="field-label" htmlFor="recording-title">
              Title
            </label>
            <input
              defaultValue=""
              id="recording-title"
              name="title"
              placeholder="Participant interview 042"
              type="text"
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="recording-language">
              Language hint
            </label>
            <select defaultValue="english" id="recording-language" name="languageHint">
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
                name="file"
                ref={fileInputRef}
                required={mode === "upload"}
                type="file"
              />
              <p className="field-note">
                The current demo persists files on the server filesystem under
                <code> data/media</code>.
              </p>
            </div>
          ) : (
            <div className="stack">
              <input
                accept="audio/*"
                className="sr-only"
                name="file"
                ref={recordedInputRef}
                type="file"
              />

              <div className="button-row">
                <button
                  className="button button-secondary"
                  disabled={recorderState === "recording"}
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

          <div className="review-actions">
            <SubmitButton disabled={mode === "record" && recorderState !== "ready"} />
          </div>
        </form>
      </div>
    </section>
  );
}
