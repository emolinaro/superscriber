"use client";

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  PolicyDecision,
  Recording,
  TranscriptRevision,
} from "@/domain/models";
import {
  APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS,
  type ApprovedTranscriptExportFormat,
  buildApprovedTranscriptExportUrl,
} from "@/lib/approved-transcript-export";
import { formatSegmentWindow } from "@/lib/format";

type Action = (formData: FormData) => void | Promise<void>;

const WAVE_BAR_COUNT = 54;
const IDLE_WAVE_BARS = Array.from({ length: WAVE_BAR_COUNT }, (_, index) => {
  const pattern = [24, 56, 74, 48, 84, 36];
  return pattern[index % pattern.length] ?? 48;
});
const COMPACT_REVIEW_BREAKPOINT_PX = 760;
const APPROVED_EXPORT_SHEET_GAP_PX = 12;
const APPROVED_EXPORT_FORMAT_DESCRIPTIONS: Record<
  ApprovedTranscriptExportFormat,
  string
> = {
  docx: "Formatted handoff for policy-approved document editing.",
  txt: "Plain text export for simple archival or handoff.",
  srt: "Subtitle cues with numbered timestamps for timed playback.",
  vtt: "Web caption cues for browser and streaming workflows.",
  csv: "Spreadsheet-ready rows for segment-by-segment analysis.",
  tsv: "Tab-separated rows for safer spreadsheet ingestion.",
  json: "Structured transcript data for system-to-system exchange.",
};

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
  approvedTranscriptExportBaseUrl: string | null;
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
  approvedTranscriptExportBaseUrl,
  saveAction,
  submitAction,
  approveAction,
  reopenAction,
}: ReviewWorkspaceProps) {
  const reviewShellRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const approvedExportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const approvedExportDialogRef = useRef<HTMLDivElement | null>(null);
  const approvedExportCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const [segments, setSegments] = useState(currentRevision?.segments ?? []);
  const [summary, setSummary] = useState(
    currentRevision?.summary ?? "Transcript draft is not ready yet.",
  );
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [isApprovedExportSheetOpen, setIsApprovedExportSheetOpen] = useState(false);
  const [approvedExportSheetPosition, setApprovedExportSheetPosition] = useState({
    top: 0,
    right: 0,
  });
  const [mediaElement, setMediaElement] = useState<HTMLAudioElement | HTMLVideoElement | null>(
    null,
  );
  const [waveBars, setWaveBars] = useState(IDLE_WAVE_BARS);
  const previousApprovedExportFocusRef = useRef<HTMLElement | null>(null);
  const hasSegments = segments.length > 0;

  useEffect(() => {
    setSegments(currentRevision?.segments ?? []);
    setSummary(currentRevision?.summary ?? "Transcript draft is not ready yet.");
  }, [currentRevision?.id]);

  useEffect(() => {
    setWaveBars(IDLE_WAVE_BARS);
  }, [currentRevision?.id, mediaUrl]);

  useEffect(() => {
    if (!approvedTranscriptExportBaseUrl) {
      setIsApprovedExportSheetOpen(false);
    }
  }, [approvedTranscriptExportBaseUrl]);

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

  useEffect(() => {
    if (!isApprovedExportSheetOpen) {
      return;
    }

    function getFocusableApprovedExportElements() {
      const dialog = approvedExportDialogRef.current;
      if (!dialog) {
        return [];
      }

      return Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeApprovedExportSheet();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getFocusableApprovedExportElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        approvedExportDialogRef.current?.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const dialogContainsActiveElement =
        activeElement !== null &&
        approvedExportDialogRef.current?.contains(activeElement) === true;

      if (event.shiftKey) {
        if (!dialogContainsActiveElement || activeElement === firstElement) {
          event.preventDefault();
          lastElement?.focus();
        }
        return;
      }

      if (!dialogContainsActiveElement || activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isApprovedExportSheetOpen]);

  useEffect(() => {
    if (!isApprovedExportSheetOpen) {
      return;
    }

    function syncApprovedExportSheetPosition() {
      const shell = reviewShellRef.current;
      const trigger = approvedExportTriggerRef.current;
      if (!shell || !trigger) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      setApprovedExportSheetPosition({
        top: triggerRect.bottom - shellRect.top + APPROVED_EXPORT_SHEET_GAP_PX,
        right: Math.max(0, shellRect.right - triggerRect.right),
      });
    }

    syncApprovedExportSheetPosition();
    const animationFrame = requestAnimationFrame(() => {
      syncApprovedExportSheetPosition();
      approvedExportCloseButtonRef.current?.focus();
    });

    window.addEventListener("resize", syncApprovedExportSheetPosition);
    window.addEventListener("scroll", syncApprovedExportSheetPosition, true);

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", syncApprovedExportSheetPosition);
      window.removeEventListener("scroll", syncApprovedExportSheetPosition, true);
    };
  }, [isApprovedExportSheetOpen]);

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

  function openApprovedExportSheet() {
    previousApprovedExportFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIsApprovedExportSheetOpen(true);
  }

  function closeApprovedExportSheet() {
    setIsApprovedExportSheetOpen(false);
    requestAnimationFrame(() => {
      if (approvedExportTriggerRef.current) {
        approvedExportTriggerRef.current.focus();
        return;
      }

      previousApprovedExportFocusRef.current?.focus();
    });
  }

  function formatApprovedExportGroupLabel(groupId: string, groupLabel: string) {
    return groupId === "structured" ? `${groupLabel} data` : groupLabel;
  }

  const approvedExportSheetStyle = {
    "--review-export-sheet-top": `${approvedExportSheetPosition.top}px`,
    "--review-export-sheet-right": `${approvedExportSheetPosition.right}px`,
  } as CSSProperties;

  return (
    <div className="review-shell review-shell-annotation" ref={reviewShellRef}>
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
          {approvedTranscriptExportBaseUrl ? (
            <button
              aria-expanded={isApprovedExportSheetOpen}
              aria-haspopup="dialog"
              className="button button-quiet"
              onClick={openApprovedExportSheet}
              ref={approvedExportTriggerRef}
              type="button"
            >
              Export approved
            </button>
          ) : null}
        </div>
      </div>

      {isApprovedExportSheetOpen && approvedTranscriptExportBaseUrl ? (
        <div
          className="review-export-sheet-backdrop"
          onClick={closeApprovedExportSheet}
          role="presentation"
          style={approvedExportSheetStyle}
        >
          <div
            aria-labelledby="approved-export-sheet-title"
            aria-modal="true"
            className="review-export-sheet"
            onClick={(event) => event.stopPropagation()}
            ref={approvedExportDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="review-export-sheet-header">
              <div className="stack-tight">
                <p className="eyebrow">Approved transcript</p>
                <h3 className="section-title" id="approved-export-sheet-title">
                  Approved export formats
                </h3>
                <p className="body-copy">
                  Choose a policy-approved format for the locked transcript.
                </p>
              </div>
              <button
                aria-label="Close approved export formats"
                className="button button-secondary review-export-sheet-close"
                onClick={closeApprovedExportSheet}
                ref={approvedExportCloseButtonRef}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="review-export-group-list">
              {APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS.map((group) => {
                const groupHeadingId = `approved-export-group-${group.id}`;
                return (
                  <section
                    aria-labelledby={groupHeadingId}
                    className="review-export-group"
                    key={group.id}
                  >
                    <h4 className="review-export-group-title" id={groupHeadingId}>
                      {formatApprovedExportGroupLabel(group.id, group.label)}
                    </h4>
                    <div className="review-export-option-list">
                      {group.formats.map((format) => (
                        <a
                          aria-label={format.toUpperCase()}
                          className="review-export-option"
                          href={buildApprovedTranscriptExportUrl(
                            approvedTranscriptExportBaseUrl,
                            format,
                          )}
                          key={format}
                          onClick={closeApprovedExportSheet}
                        >
                          <strong className="review-export-option-label">
                            {format.toUpperCase()}
                          </strong>
                          <span className="review-export-option-description">
                            {APPROVED_EXPORT_FORMAT_DESCRIPTIONS[format]}
                          </span>
                        </a>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

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

              <div className="segment-list segment-list-annotation review-segment-list">
                {hasSegments ? (
                  segments.map((segment) => {
                    const windowLabel = formatSegmentWindow(segment.startMs, segment.endMs);
                    const jumpLabel = `Jump to ${windowLabel} for ${segment.speakerLabel}`;
                    const confidenceLabel = `Confidence ${(segment.confidence * 100).toFixed(0)}%`;

                    return (
                      <article
                        key={segment.id}
                        className="review-segment-row segment segment-annotation"
                        data-active={segment.id === activeSegmentId}
                        data-review-segment-id={segment.id}
                      >
                        <div className="review-segment-rail segment-header">
                          <button
                            aria-label={jumpLabel}
                            className="review-segment-jump segment-jump-button"
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
