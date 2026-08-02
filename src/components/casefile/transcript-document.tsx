import type { TranscriptSegment } from "@/domain/models";
import { formatSegmentWindow } from "@/lib/format";

type TranscriptDocumentProps = {
  activeSegmentId: string | null;
  editable: boolean;
  phoneSafetyMode: boolean;
  summary: string;
  segments: TranscriptSegment[];
  onSummaryChange: (value: string) => void;
  onSeek: (startMs: number) => void;
  onUpdateSpeaker: (segmentId: string, value: string) => void;
  onUpdateText: (segmentId: string, value: string) => void;
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
}: TranscriptDocumentProps) {
  const readOnly = !editable || phoneSafetyMode;

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

      <div className="transcript-document__segments">
        {segments.map((segment, index) => {
          const windowLabel = formatSegmentWindow(segment.startMs, segment.endMs);
          const active = segment.id === activeSegmentId;

          return (
            <article
              aria-current={active ? "true" : undefined}
              aria-label={`Transcript segment ${index + 1}, ${windowLabel}`}
              className="transcript-segment"
              data-active={active || undefined}
              key={segment.id}
            >
              <button
                aria-label={`Play from ${windowLabel}`}
                className="transcript-segment__timestamp"
                onClick={() => onSeek(segment.startMs)}
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
