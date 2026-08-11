function msClock(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Live engine progress bar. Drives only from engine-derived samples (percent
// computed server-side from transcribedUntil/audioDuration). While no segment
// has been emitted the bar shows a liveness pulse instead of a misleading
// constant fill.
export function TranscriptionProgressBar({
  percent,
  segmentsSeen,
  transcribedUntilMs,
  audioDurationMs,
  tone = "default",
}: {
  percent: number | null;
  segmentsSeen?: number | null;
  transcribedUntilMs?: number | null;
  audioDurationMs?: number | null;
  tone?: "default" | "compact";
}) {
  const engineKnown = percent !== null;
  const clamped = engineKnown ? Math.max(0, Math.min(100, percent)) : null;

  const parts: string[] = [];
  if (segmentsSeen && segmentsSeen > 0) {
    parts.push(`Segment ${segmentsSeen}`);
  }
  if (
    typeof transcribedUntilMs === "number" &&
    typeof audioDurationMs === "number" &&
    audioDurationMs > 0
  ) {
    parts.push(`${msClock(transcribedUntilMs)} of ${msClock(audioDurationMs)}`);
  }

  return (
    <div className={`tp-progress${tone === "compact" ? " tp-progress--compact" : ""}`}>
      <div className="tp-progress__heading">
        <span>
          Transcribing{engineKnown ? ` ${clamped}%` : ""}
        </span>
        {parts.length > 0 ? (
          <span className="tp-progress__cue">{parts.join(" · ")}</span>
        ) : (
          <span className="tp-progress__cue tp-progress__cue--idle">
            engine warming up - no segment emitted yet
          </span>
        )}
      </div>
      <div
        aria-label="Transcription progress"
        aria-valuemax={100}
        aria-valuemin={0}
        {...(engineKnown ? { "aria-valuenow": clamped as number } : {})}
        className="tp-progress__track"
        role="progressbar"
        data-live={engineKnown ? "true" : "warming"}
      >
        {engineKnown ? (
          <span className="tp-progress__fill" style={{ width: `${clamped}%` }} />
        ) : (
          <span className="tp-progress__pulse" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
