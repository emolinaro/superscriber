import { useEffect, useRef } from "react";
import type { TranscriptSegment } from "@/domain/models";
import { formatSegmentWindow } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";

type TranscriptDocumentProps = {
  activeSegmentId: string | null;
  editable: boolean;
  phoneSafetyMode: boolean;
  /** True when phone safety (not permissions or history) removed the editors. */
  safetyStripped?: boolean;
  summary: string;
  segments: TranscriptSegment[];
  /** demo-diff-highlights (casefile UX batch): inline "edited vs parent vN"
     mark on segments the viewed revision changed relative to its in-casefile
     parent. */
  diffHighlight?: { parentVersion: number; editedSegmentIds: string[] } | null;
  onSummaryChange: (value: string) => void;
  /**
   * True while the media element is playing inside the active segment. The
   * active segment's timestamp button doubles as a play/pause toggle
   * (segment-play-toggle) and must expose that pressed state truthfully.
   */
  activeSegmentPlaying?: boolean;
  onSeek: (segment: TranscriptSegment) => void;
  onUpdateSpeaker: (segmentId: string, value: string) => void;
  onUpdateText: (segmentId: string, value: string) => void;
  /**
   * Player rail/marker asked to surface one segment inline: scroll it into
   * view inside the nearest scrollport and focus its inline review
   * affordance (the segment's editor when editable, otherwise its timestamp)
   * without mutating any transcript data.
   */
  reviewFocus?: { segmentId: string; nonce: number } | null;
};

export function TranscriptDocument({
  activeSegmentId,
  editable,
  phoneSafetyMode,
  summary,
  segments,
  onSummaryChange,
  onSeek,
  onUpdateSpeaker,
  onUpdateText,
  safetyStripped = false,
  diffHighlight = null,
  reviewFocus = null,
  activeSegmentPlaying = false,
}: TranscriptDocumentProps) {
  const readOnly = !editable || phoneSafetyMode;
  // Guarded presentation (narrow/coarse surface) silently swaps the segment
  // editors for static copy; name the withheld affordance inline so the guard
  // never looks like broken editing (demo-segment-edit). The workspace passes
  // `safetyStripped` when editing would otherwise be possible - permission-
  // or history-based read-only states keep their own, separate story.
  const segmentsRef = useRef<HTMLDivElement>(null);

  // Playback follow: keep the active segment visible inside the nearest
  // scrollport (the bounded .casefile-main scrollport on desktop, the window
  // elsewhere). The segments list itself is never a scroller - the bounded
  // shell keeps .casefile-main as the single scrollport.
  useEffect(() => {
    const container = segmentsRef.current;
    if (!container || !activeSegmentId) {
      return;
    }
    const row = container.querySelector<HTMLElement>("[data-active]");
    if (!row) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({
      block: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeSegmentId]);

  // Rail/marker-initiated jump: bring the segment into view inside the
  // nearest scrollport (same single-scrollport model as playback follow),
  // then focus its inline review affordance.
  useEffect(() => {
    if (!reviewFocus) {
      return;
    }
    const container = segmentsRef.current;
    if (!container) {
      return;
    }
    const row = container.querySelector<HTMLElement>(
      `[data-segment-id="${CSS.escape(reviewFocus.segmentId)}"]`,
    );
    if (!row) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({
      block: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });

    // Priority order matters: querySelector would otherwise return the first
    // match in tree order (the timestamp precedes the editors in the row).
    const affordance =
      row.querySelector<HTMLElement>("[data-editor-key^='text:']") ??
      row.querySelector<HTMLElement>("[data-editor-key^='speaker:']") ??
      row.querySelector<HTMLElement>(".transcript-segment__timestamp");
    affordance?.focus();
  }, [reviewFocus]);

  return (
    <section aria-label="Transcript document" className="transcript-document" data-testid="transcript-start">
      <div className="field transcript-document__summary">
        <label className="field-label" htmlFor="revision-summary">
          Revision summary
        </label>
        {readOnly ? (
          <p className="transcript-document__summary-copy">{summary}</p>
        ) : (
          <input
            aria-label="Revision summary"
            data-editor-key="summary"
            id="revision-summary"
            onChange={(event) => onSummaryChange(event.currentTarget.value)}
            type="text"
            value={summary}
          />
        )}
      </div>

      <div className="transcript-document__segments" ref={segmentsRef}>
        {safetyStripped ? (
          <InlineNotice tone="info">
            Review and decisions require a tablet or desktop.
          </InlineNotice>
        ) : null}
        {segments.map((segment, index) => {
          const windowLabel = formatSegmentWindow(segment.startMs, segment.endMs);
          const active = segment.id === activeSegmentId;

          return (
            <article
              aria-current={active ? "true" : undefined}
              aria-label={`Transcript segment ${index + 1}, ${windowLabel}`}
              className="transcript-segment"
              data-active={active || undefined}
              data-edited-diff={diffHighlight?.editedSegmentIds.includes(segment.id) || undefined}
              data-segment-id={segment.id}
              key={segment.id}
            >
              {diffHighlight?.editedSegmentIds.includes(segment.id) ? (
                <span className="transcript-segment__diff-flag" role="note">
                  Edited vs v{diffHighlight.parentVersion}
                </span>
              ) : null}
              <button
                aria-label={
                  active
                    ? `Play or pause segment ${index + 1}, ${windowLabel}`
                    : `Play from ${windowLabel}`
                }
                aria-pressed={active ? activeSegmentPlaying : undefined}
                className="transcript-segment__timestamp"
                onClick={() => onSeek(segment)}
                type="button"
              >
                {windowLabel}
              </button>

              <div className="transcript-segment__speaker">
                {readOnly ? (
                  <strong>{segment.speakerLabel}</strong>
                ) : (
                  <input
                    aria-label={`Speaker for segment ${index + 1}, ${windowLabel}`}
                    data-editor-key={`speaker:${segment.id}`}
                    onChange={(event) =>
                      onUpdateSpeaker(segment.id, event.currentTarget.value)
                    }
                    type="text"
                    value={segment.speakerLabel}
                  />
                )}
              </div>

              <div className="transcript-segment__text">
                {readOnly ? (
                  <p>{segment.text}</p>
                ) : (
                  <textarea
                    aria-label={`Transcript for segment ${index + 1}, ${windowLabel}`}
                    data-editor-key={`text:${segment.id}`}
                    onChange={(event) => onUpdateText(segment.id, event.currentTarget.value)}
                    value={segment.text}
                  />
                )}
                <span className="field-note">
                  Confidence {Math.round(segment.confidence * 100)}%
                </span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
