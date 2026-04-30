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

const WAVE_BARS = Array.from({ length: 54 }, (_, index) => index);
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
  const [segments, setSegments] = useState(currentRevision?.segments ?? []);
  const [summary, setSummary] = useState(
    currentRevision?.summary ?? "Transcript draft is not ready yet.",
  );
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const hasSegments = segments.length > 0;

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
            Move through speaker turns, correct text in place, and keep the full
            review session inside the browser.
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
              onClick={() => scrollToSection("review-turns")}
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
                  {WAVE_BARS.map((bar) => (
                    <span key={bar} />
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

            <div className="annotation-body">
              <section className="annotation-column annotation-timeline-column" id="review-turns">
                <div className="annotation-panel annotation-panel-muted stack">
                  <div className="status-row">
                    <div className="stack-tight">
                      <h3 className="annotation-title">Speaker turns</h3>
                      <p className="field-note">
                        Compact and scannable, built for quick jumps.
                      </p>
                    </div>
                    <span className="badge">
                      {hasSegments ? `${segments.length} segments` : "Waiting"}
                    </span>
                  </div>

                  <div className="timeline-list timeline-list-annotation">
                    {hasSegments ? (
                      segments.map((segment) => (
                        <button
                          key={segment.id}
                          className="timeline-button timeline-button-annotation"
                          data-active={segment.id === activeSegmentId}
                          onClick={() => seekTo(segment.startMs)}
                          type="button"
                        >
                          <div className="status-row">
                            <strong>
                              {formatSegmentWindow(segment.startMs, segment.endMs)} ·{" "}
                              {segment.speakerLabel}
                            </strong>
                            <span className="field-note">
                              {segment.id === activeSegmentId ? "In view" : "Jump point"}
                            </span>
                          </div>
                          <span className="body-copy">
                            {segment.text.slice(0, 132) || "No transcript text yet."}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="timeline-empty">
                        <p className="body-copy">
                          Segments will appear here after verification and transcription
                          complete.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section className="annotation-column annotation-editor-column" id="review-draft">
                <div className="annotation-panel stack">
                  <div className="status-row">
                    <div className="stack-tight">
                      <h3 className="annotation-title">Transcript draft</h3>
                      <p className="field-note">
                        A document-like surface for careful reading and correction.
                      </p>
                    </div>
                    <span className="badge">
                      {hasSegments ? "Ready to save" : "No draft yet"}
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

                  <div className="segment-list segment-list-annotation">
                    {hasSegments ? (
                      segments.map((segment) => (
                        <article
                          key={segment.id}
                          className="segment segment-annotation"
                          data-active={segment.id === activeSegmentId}
                        >
                          <div className="segment-header">
                            {isCompactViewport ? (
                              <strong>{segment.speakerLabel}</strong>
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
                            <button
                              className="segment-jump-button"
                              onClick={() => seekTo(segment.startMs)}
                              type="button"
                            >
                              {formatSegmentWindow(segment.startMs, segment.endMs)}
                            </button>
                          </div>
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
                          <span className="field-note">
                            Confidence {(segment.confidence * 100).toFixed(0)}%
                          </span>
                        </article>
                      ))
                    ) : (
                      <div className="segment segment-empty-state">
                        <p className="body-copy">
                          This recording is still moving through verification or
                          transcription.
                        </p>
                      </div>
                    )}
                  </div>

                  {isCompactViewport ? (
                    <div className="review-compact-note review-compact-note-muted">
                      Editing and approval actions are hidden on phone-sized screens
                      to keep the review flow constrained.
                    </div>
                  ) : (
                    <div
                      className="review-actions review-actions-annotation"
                      id="review-approval"
                    >
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
                  )}
                </div>
              </section>
            </div>

            <div className="annotation-assist-note">
              <strong>Prototype behavior:</strong> click any speaker turn to focus the
              matching transcript card. Playback, correction, and approval stay in the
              same browser review job.
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
