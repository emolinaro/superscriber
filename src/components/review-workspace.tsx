"use client";

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  PolicyDecision,
  Recording,
  TranscriptRevision,
} from "@/domain/models";
import { formatSegmentWindow } from "@/lib/format";

type Action = (formData: FormData) => void | Promise<void>;

const WAVE_BAR_COUNT = 54;
const IDLE_WAVE_BARS = Array.from({ length: WAVE_BAR_COUNT }, (_, index) => {
  const pattern = [24, 56, 74, 48, 84, 36];
  return pattern[index % pattern.length] ?? 48;
});
const COMPACT_REVIEW_BREAKPOINT_PX = 760;

function FormButton({
  children,
  className,
  disabled,
  formAction,
}: {
  children: ReactNode;
  className: string;
  disabled?: boolean;
  formAction?: ButtonHTMLAttributes<HTMLButtonElement>["formAction"];
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className={className}
      disabled={disabled || pending}
      formAction={formAction}
      type="submit"
    >
      {pending ? "Working..." : children}
    </button>
  );
}

function formatPlaybackClock(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

type ReviewWorkspaceProps = {
  recording: Recording;
  currentRevision: TranscriptRevision | null;
  policyDecision: PolicyDecision;
  mediaUrl: string | null;
  exportUrl: string | null;
  saveAction: Action;
  submitAction: Action;
  approveAction: Action;
  reopenAction: Action;
};

export function ReviewWorkspace({
  recording,
  currentRevision,
  policyDecision,
  mediaUrl,
  exportUrl,
  saveAction,
  submitAction,
  approveAction,
  reopenAction,
}: ReviewWorkspaceProps) {
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const [segments, setSegments] = useState(currentRevision?.segments ?? []);
  const [summary, setSummary] = useState(
    currentRevision?.summary ?? "Transcript draft is not ready yet.",
  );
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [mediaElement, setMediaElement] = useState<HTMLAudioElement | HTMLVideoElement | null>(
    null,
  );
  const [waveBars, setWaveBars] = useState(IDLE_WAVE_BARS);
  const hasSegments = segments.length > 0;

  useEffect(() => {
    setSegments(currentRevision?.segments ?? []);
    setSummary(currentRevision?.summary ?? "Transcript draft is not ready yet.");
  }, [currentRevision?.id]);

  useEffect(() => {
    setWaveBars(IDLE_WAVE_BARS);
  }, [currentRevision?.id, mediaUrl]);

  const activeSegmentIndex = segments.findIndex(
    (segment) => currentMs >= segment.startMs && currentMs <= segment.endMs,
  );
  const activeSegmentId =
    activeSegmentIndex >= 0 ? segments[activeSegmentIndex]?.id ?? null : null;
  const playbackProgress = durationMs > 0 ? Math.min((currentMs / durationMs) * 100, 100) : 32;
  const hasPlayableMedia = Boolean(mediaUrl);
  const waveStyle = {
    "--playhead-position": `${playbackProgress}%`,
  } as CSSProperties;

  useEffect(() => {
    const mediaQuery = window.matchMedia(
      `(max-width: ${COMPACT_REVIEW_BREAKPOINT_PX}px)`,
    );

    function syncViewport() {
      setIsCompactViewport(mediaQuery.matches);
    }

    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);

    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    const element = mediaElement;
    if (!element || !mediaUrl) {
      return;
    }
    const activeElement = element;

    let cancelled = false;

    function stopAnimation() {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    }

    function sampleWaveform() {
      const analyser = analyserRef.current;
      if (!analyser || cancelled) {
        return;
      }

      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);

      const bucketSize = Math.max(1, Math.floor(data.length / WAVE_BAR_COUNT));
      const nextBars = Array.from({ length: WAVE_BAR_COUNT }, (_, index) => {
        const start = index * bucketSize;
        const end = Math.min(start + bucketSize, data.length);
        let total = 0;
        for (let cursor = start; cursor < end; cursor += 1) {
          total += data[cursor] ?? 0;
        }
        const average = total / Math.max(1, end - start);
        return Math.max(18, Math.min(92, Math.round((average / 255) * 100)));
      });

      setWaveBars(nextBars);
      animationFrameRef.current = requestAnimationFrame(sampleWaveform);
    }

    async function startAnimation() {
      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext();
        }
        const audioContext = audioContextRef.current;
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }

        if (!sourceNodeRef.current) {
          sourceNodeRef.current = audioContext.createMediaElementSource(activeElement);
        }

        if (!analyserRef.current) {
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.82;
          sourceNodeRef.current.connect(analyser);
          analyser.connect(audioContext.destination);
          analyserRef.current = analyser;
        }

        stopAnimation();
        sampleWaveform();
      } catch {
        setWaveBars(IDLE_WAVE_BARS);
      }
    }

    function handlePlay() {
      void startAnimation();
    }

    function handlePause() {
      stopAnimation();
    }

    activeElement.addEventListener("play", handlePlay);
    activeElement.addEventListener("pause", handlePause);
    activeElement.addEventListener("ended", handlePause);

    if (!activeElement.paused && !activeElement.ended) {
      void startAnimation();
    }

    return () => {
      cancelled = true;
      stopAnimation();
      activeElement.removeEventListener("play", handlePlay);
      activeElement.removeEventListener("pause", handlePause);
      activeElement.removeEventListener("ended", handlePause);
    };
  }, [mediaElement, mediaUrl]);

  function updateSegment(
    segmentId: string,
    key: "speakerLabel" | "text",
    value: string,
  ) {
    setSegments((existing) =>
      existing.map((segment) =>
        segment.id === segmentId ? { ...segment, [key]: value } : segment,
      ),
    );
  }

  function attachMedia(node: HTMLAudioElement | HTMLVideoElement | null) {
    mediaRef.current = node;
    setMediaElement(node);
  }

  function syncPlaybackPosition(nextSeconds: number) {
    setCurrentMs(nextSeconds * 1000);
  }

  function captureDuration(node: HTMLAudioElement | HTMLVideoElement) {
    if (Number.isFinite(node.duration)) {
      setDurationMs(node.duration * 1000);
    }
  }

  function seekTo(ms: number) {
    if (!mediaRef.current) {
      return;
    }

    mediaRef.current.currentTime = ms / 1000;
    mediaRef.current.play().catch(() => undefined);
    setCurrentMs(ms);
  }

  function playMedia() {
    mediaRef.current?.play().catch(() => undefined);
  }

  function pauseMedia() {
    mediaRef.current?.pause();
  }

  function jumpBack(seconds: number) {
    if (!mediaRef.current) {
      return;
    }

    const nextMs = Math.max(0, currentMs - seconds * 1000);
    mediaRef.current.currentTime = nextMs / 1000;
    setCurrentMs(nextMs);
  }

  function scrollToSection(sectionId: string) {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  return (
    <div className="review-shell review-shell-annotation">
      <div className="review-topbar review-topbar-annotation">
        <div className="stack-tight">
          <p className="eyebrow">Transcript draft</p>
          <h2 className="section-title">Document-style correction workspace.</h2>
          <p className="body-copy">
            Review each segment in one aligned surface, correct text in place, and
            keep the full review session inside the browser.
          </p>
        </div>
        <div className="kicker-row review-chip-row">
          {isCompactViewport ? (
            <span className="pill" data-tone="info">
              Phone view: read-only
            </span>
          ) : policyDecision.canEditDraft ? (
            <span className="pill" data-tone="ok">
              Draft editing enabled
            </span>
          ) : null}
          {exportUrl ? (
            <a className="button button-quiet" href={exportUrl}>
              Export approved text
            </a>
          ) : null}
        </div>
      </div>

      <form className="annotation-form">
        <input name="recordingId" type="hidden" value={recording.id} />
        <input name="currentRevisionId" type="hidden" value={currentRevision?.id ?? ""} />
        <input name="segmentsJson" type="hidden" value={JSON.stringify(segments)} />

        <div className="annotation-workspace-shell">
          <aside className="annotation-rail" aria-label="Review workspace actions">
            <button
              className="rail-button"
              disabled={!hasPlayableMedia}
              onClick={playMedia}
              type="button"
            >
              Play
            </button>
            <button
              className="rail-button"
              disabled={!hasPlayableMedia}
              onClick={pauseMedia}
              type="button"
            >
              Pause
            </button>
            <button
              className="rail-button"
              disabled={!hasPlayableMedia}
              onClick={() => jumpBack(10)}
              type="button"
            >
              Jump back 10s
            </button>
            <button
              className="rail-button"
              onClick={() => scrollToSection("review-segments")}
              type="button"
            >
              Need review
            </button>
            <button
              className="rail-button"
              onClick={() => scrollToSection("review-history")}
              type="button"
            >
              History
            </button>
            <button
              className="rail-button"
              onClick={() => scrollToSection("review-audit")}
              type="button"
            >
              Audit
            </button>
          </aside>

          <div className="annotation-canvas">
            <section className="annotation-ribbon annotation-ribbon-rich">
              <div className="annotation-ribbon-header">
                <div className="stack-tight">
                  <strong className="annotation-title">Playback ribbon</strong>
                  <p className="body-copy">
                    A narrow transport strip instead of a heavy media module.
                  </p>
                </div>
                <span className="badge">
                  {mediaUrl ? "Server stream" : "Awaiting media"}
                </span>
              </div>

              <div className="transport-chip-row">
                <span className="transport-chip transport-chip-time">
                  {formatPlaybackClock(currentMs)}
                </span>
                <span className="transport-chip">
                  {mediaUrl
                    ? "Playback locked to server session"
                    : "No media asset attached yet"}
                </span>
                <span className="transport-chip">
                  {hasSegments ? `${segments.length} segments ready` : "Waiting for segments"}
                </span>
              </div>

                <div className="transport-wave-shell" style={waveStyle}>
                <div className="transport-wave-bars" aria-hidden="true">
                  {waveBars.map((height, index) => (
                    <span key={index} style={{ height: `${height}%` }} />
                  ))}
                </div>
                <div className="transport-playhead" />
              </div>

              {mediaUrl ? (
                <div className="transport-media-shell">
                  {recording.mediaKind === "video" ? (
                    <video
                      controls
                      onLoadedMetadata={(event) => captureDuration(event.currentTarget)}
                      onTimeUpdate={(event) =>
                        syncPlaybackPosition(event.currentTarget.currentTime)
                      }
                      ref={attachMedia}
                      src={mediaUrl}
                    />
                  ) : (
                    <audio
                      controls
                      onLoadedMetadata={(event) => captureDuration(event.currentTarget)}
                      onTimeUpdate={(event) =>
                        syncPlaybackPosition(event.currentTarget.currentTime)
                      }
                      ref={attachMedia}
                      src={mediaUrl}
                    />
                  )}
                </div>
              ) : (
                <div className="media-shell media-shell-ribbon media-shell-empty">
                  <p className="body-copy media-empty-copy">
                    {policyDecision.canViewMedia
                      ? "No media asset is attached to this demo record yet."
                      : "Media playback is denied for this role under the current policy."}
                  </p>
                </div>
              )}
            </section>

            <section
              className="annotation-panel stack annotation-review-panel"
              id="review-segments"
            >
              <div className="status-row">
                <div className="stack-tight">
                  <h3 className="annotation-title">Transcript draft</h3>
                  <p className="field-note">
                    Each segment keeps time, speaker, and transcript aligned in one
                    review row.
                  </p>
                </div>
                <span className="badge">
                  {hasSegments ? `${segments.length} segments` : "No draft yet"}
                </span>
              </div>

              {isCompactViewport ? (
                <div className="review-compact-note">
                  Phone-sized review stays read-only. Use a wider screen to edit,
                  submit, or approve this transcript.
                </div>
              ) : null}

              <div className="field annotation-summary-field">
                <label className="field-label" htmlFor="revision-summary">
                  Revision summary
                </label>
                {isCompactViewport ? (
                  <div className="field-readonly">{summary}</div>
                ) : (
                  <input
                    id="revision-summary"
                    name="summary"
                    onChange={(event) => setSummary(event.currentTarget.value)}
                    type="text"
                    value={summary}
                  />
                )}
              </div>

              <div className="review-segment-list">
                {hasSegments ? (
                  segments.map((segment) => {
                    const windowLabel = formatSegmentWindow(segment.startMs, segment.endMs);
                    const jumpLabel = `Jump to ${windowLabel} for ${segment.speakerLabel}`;
                    const confidenceLabel = `Confidence ${(segment.confidence * 100).toFixed(0)}%`;

                    return (
                      <article
                        key={segment.id}
                        className="review-segment-row"
                        data-active={segment.id === activeSegmentId}
                        data-review-segment-id={segment.id}
                      >
                        <div className="review-segment-rail">
                          <button
                            aria-label={jumpLabel}
                            className="review-segment-jump"
                            onClick={() => seekTo(segment.startMs)}
                            type="button"
                          >
                            {windowLabel}
                          </button>

                          {isCompactViewport ? (
                            <strong className="review-segment-speaker">
                              {segment.speakerLabel}
                            </strong>
                          ) : (
                            <input
                              aria-label={`Speaker label for ${segment.id}`}
                              onChange={(event) =>
                                updateSegment(
                                  segment.id,
                                  "speakerLabel",
                                  event.currentTarget.value,
                                )
                              }
                              type="text"
                              value={segment.speakerLabel}
                            />
                          )}

                          <span className="field-note">
                            {segment.id === activeSegmentId ? "Active now" : "Jump to audio"}
                          </span>
                          <span className="field-note">{confidenceLabel}</span>
                        </div>

                        <div className="review-segment-editor">
                          <div className="segment-copy-shell">
                            {isCompactViewport ? (
                              <p className="segment-readonly-copy">{segment.text}</p>
                            ) : (
                              <textarea
                                aria-label={`Transcript text for ${segment.id}`}
                                onChange={(event) =>
                                  updateSegment(segment.id, "text", event.currentTarget.value)
                                }
                                value={segment.text}
                              />
                            )}
                          </div>
                          <span className="field-note review-segment-footer">
                            Playback and correction stay in the same review row.
                          </span>
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="segment segment-empty-state">
                    <p className="body-copy">
                      This recording is still moving through verification or transcription.
                    </p>
                  </div>
                )}
              </div>

              {!isCompactViewport ? (
                <div className="review-actions review-actions-annotation" id="review-approval">
                  {policyDecision.canEditDraft ? (
                    <FormButton className="button button-secondary" formAction={saveAction}>
                      Save draft
                    </FormButton>
                  ) : null}
                  {policyDecision.canSubmitForApproval ? (
                    <FormButton
                      className="button button-primary"
                      disabled={!hasSegments}
                      formAction={submitAction}
                    >
                      Submit revision
                    </FormButton>
                  ) : null}
                </div>
              ) : null}
            </section>

            <div className="annotation-assist-note">
              <strong>Prototype behavior:</strong> review each aligned segment row,
              jump from the time window, and keep playback, correction, and approval
              in the same browser review job.
            </div>

            {!isCompactViewport && policyDecision.canApprove && recording.pendingRevisionId ? (
              <div className="review-main-footer">
                <input
                  name="pendingRevisionId"
                  type="hidden"
                  value={recording.pendingRevisionId}
                />
                <FormButton className="button button-primary" formAction={approveAction}>
                  Approve current revision
                </FormButton>
              </div>
            ) : null}

            {!isCompactViewport &&
            policyDecision.canReopenApprovedTranscript &&
            recording.approvedRevisionId ? (
              <div className="review-main-footer">
                <input
                  name="approvedRevisionId"
                  type="hidden"
                  value={recording.approvedRevisionId}
                />
                <FormButton className="button button-secondary" formAction={reopenAction}>
                  Reopen approved transcript
                </FormButton>
              </div>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}
