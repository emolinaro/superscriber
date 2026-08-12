"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptSegment } from "@/domain/models";
import { formatSegmentWindow } from "@/lib/format";

type WaveScrubberProps = {
  /** The audio element the scrubber visualizes. Null until mounted. */
  media: HTMLMediaElement | null;
  mediaUrl: string;
  segments: TranscriptSegment[];
  activeSegmentId: string | null;
  /** Called once the decoded wave is drawn; the parent can drop native controls. */
  onReady: () => void;
  /** Called when decoding cannot run (or fails); the parent restores native controls. */
  onUnavailable: () => void;
  /** Marker actuation: parent performs the same seek-and-locate as the rail chips. */
  onSeekToSegment: (segment: TranscriptSegment) => void;
};

function readCssColor(name: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function formatTimecode(seconds: number) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const whole = Math.floor(safe % 60);
  const tenths = Math.floor((safe * 10) % 10);
  return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${tenths}`;
}

/**
 * Decoded-wave progress bar for audio playback (demo-waveform-player).
 * The drawn wave doubles as the progress indicator: the played portion is
 * recolored and the playhead rides the media element's currentTime, while
 * click/drag on the wave seeks the same element directly. Clickable markers
 * at each transcript segment's start keep the section map on the wave, and
 * the active segment is shown as a highlight band behind the bars.
 *
 * The visual grammar follows the demo's hardened tokens: bone/paper surface,
 * ink-tinted base bars, sage progress (matching the active rail chip), rust
 * playhead, control-radius shell. If the runtime cannot decode audio (tests,
 * very old browsers), the transport silently keeps its native controls.
 */
export function WaveScrubber({
  media,
  mediaUrl,
  segments,
  activeSegmentId,
  onReady,
  onUnavailable,
  onSeekToSegment,
}: WaveScrubberProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [positionSeconds, setPositionSeconds] = useState(0);
  const [ready, setReady] = useState(false);
  const unavailableSentRef = useRef(false);

  const supported =
    typeof window !== "undefined" &&
    (typeof window.AudioContext === "function" ||
      typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext ===
        "function");

  const reportUnavailable = useCallback(() => {
    if (!unavailableSentRef.current) {
      unavailableSentRef.current = true;
      onUnavailable();
    }
  }, [onUnavailable]);

  useEffect(() => {
    if (!supported) {
      reportUnavailable();
      return;
    }
    if (!media || !containerRef.current) {
      return;
    }

    let disposed = false;
    let instance: import("wavesurfer.js").default | null = null;

    (async () => {
      try {
        const WaveSurfer = (await import("wavesurfer.js")).default;
        if (disposed || !containerRef.current) {
          return;
        }

        instance = WaveSurfer.create({
          container: containerRef.current,
          media,
          url: mediaUrl,
          height: "auto",
          barWidth: 2,
          barGap: 1,
          cursorWidth: 2,
          normalize: true,
          interact: true,
          waveColor: readCssColor("--color-line", "#d8d8cf"),
          progressColor: "rgb(42, 118, 94)",
          cursorColor: readCssColor("--color-rust-600", "#a64b2a"),
        });

        instance.on("ready", (duration: number) => {
          if (disposed) {
            return;
          }
          setDurationSeconds(duration);
          setPositionSeconds(media.currentTime || 0);
          setReady(true);
          onReady();
        });

        instance.on("error", () => {
          reportUnavailable();
        });

        instance.on("timeupdate", (current: number) => {
          setPositionSeconds(current);
        });
      } catch {
        reportUnavailable();
      }
    })();

    return () => {
      disposed = true;
      instance?.destroy();
    };
  }, [media, mediaUrl, onReady, reportUnavailable, supported]);

  const activeSegment =
    segments.find((segment) => segment.id === activeSegmentId) ?? null;

  function markerLeft(startMs: number) {
    if (durationSeconds <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (startMs / (durationSeconds * 1000)) * 100));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!media) {
      return;
    }
    const durationMs = (durationSeconds || 0) * 1000;
    let nextMs: number | null = null;
    if (event.key === "ArrowLeft") {
      nextMs = Math.max(0, media.currentTime * 1000 - 5000);
    } else if (event.key === "ArrowRight") {
      nextMs = Math.min(durationMs || Number.POSITIVE_INFINITY, media.currentTime * 1000 + 5000);
    } else if (event.key === "Home") {
      nextMs = 0;
    } else if (event.key === "End" && durationMs > 0) {
      nextMs = durationMs;
    }
    if (nextMs !== null) {
      event.preventDefault();
      media.currentTime = nextMs / 1000;
      setPositionSeconds(nextMs / 1000);
    }
  }

  return (
    <div
      className="media-transport__wave"
      data-ready={ready || undefined}
      data-testid="wave-scrubber"
    >
      <div
        aria-label="Wave progress. Click or use arrow keys to seek."
        className="media-transport__wave-stage"
        onKeyDown={handleKeyDown}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSeconds)}
        aria-valuenow={Math.round(positionSeconds)}
        aria-valuetext={`${formatTimecode(positionSeconds)} of ${formatTimecode(durationSeconds)}`}
        tabIndex={ready ? 0 : undefined}
      >
        <div
          aria-hidden="true"
          className="media-transport__wave-canvas"
          ref={containerRef}
        />
      </div>
      {ready && durationSeconds > 0 ? (
        <div aria-hidden={false} className="media-transport__wave-overlay">
          {activeSegment ? (
            <div
              aria-hidden="true"
              className="media-transport__wave-band"
              data-testid="wave-active-band"
              style={{
                left: `${markerLeft(activeSegment.startMs)}%`,
                width: `${Math.max(
                  0.5,
                  markerLeft(activeSegment.endMs) - markerLeft(activeSegment.startMs),
                )}%`,
              }}
            />
          ) : null}
          {segments.map((segment, index) => (
            <button
              aria-label={`Wave marker: segment ${index + 1}, ${formatSegmentWindow(segment.startMs, segment.endMs)}, ${segment.speakerLabel}. Seek to segment start.`}
              className="media-transport__wave-marker"
              data-active={segment.id === activeSegmentId || undefined}
              key={segment.id}
              onClick={() => onSeekToSegment(segment)}
              style={{ left: `${markerLeft(segment.startMs)}%` }}
              tabIndex={-1}
              title={`Segment ${index + 1} · ${formatSegmentWindow(segment.startMs, segment.endMs)}`}
              type="button"
            />
          ))}
        </div>
      ) : null}
      <div className="media-transport__wave-timecode" data-testid="wave-timecode">
        <span>{formatTimecode(positionSeconds)}</span>
        <span>{formatTimecode(durationSeconds)}</span>
      </div>
    </div>
  );
}
