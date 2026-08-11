"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Recording, TranscriptSegment } from "@/domain/models";
import { formatSegmentWindow } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";
import { WaveScrubber } from "@/components/casefile/wave-scrubber";

type MediaTransportProps = {
  mediaKind: Recording["mediaKind"];
  mediaUrl: string | null;
  mediaDenialReason?: string | null;
  segments: TranscriptSegment[];
  activeSegmentId: string | null;
  seekRequestMs: number | null;
  onSeekHandled: () => void;
  onActiveSegmentChange: (segmentId: string | null) => void;
  /**
   * Segment rail: seek to this segment and surface it inline in the
   * transcript list (opens its review affordance when the caller can edit).
   */
  onLocateSegment?: (segment: TranscriptSegment) => void;
};

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export function MediaTransport({
  mediaKind,
  mediaUrl,
  mediaDenialReason = null,
  segments,
  activeSegmentId,
  seekRequestMs,
  onSeekHandled,
  onActiveSegmentChange,
  onLocateSegment,
}: MediaTransportProps) {
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const [mediaEl, setMediaEl] = useState<HTMLAudioElement | HTMLVideoElement | null>(null);
  // Wave scrubber (demo-waveform-player): decoded-wave progress bar replaces
  // the stock audio controls once decoding succeeds; when the runtime cannot
  // decode, the transport keeps the native controls as the fallback.
  const [nativeControls, setNativeControls] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState("1");

  const handleWaveReady = useCallback(() => setNativeControls(false), []);
  const handleWaveUnavailable = useCallback(() => setNativeControls(true), []);

  // The Play/Pause state follows the media element itself so rail-chip seeks
  // and marker clicks (which autoplay) also flip the toggle label.
  useEffect(() => {
    if (!mediaEl) {
      return;
    }
    const syncPlaying = () => setPlaying(!mediaEl.paused && !mediaEl.ended);
    syncPlaying();
    mediaEl.addEventListener("play", syncPlaying);
    mediaEl.addEventListener("pause", syncPlaying);
    mediaEl.addEventListener("ended", syncPlaying);
    return () => {
      mediaEl.removeEventListener("play", syncPlaying);
      mediaEl.removeEventListener("pause", syncPlaying);
      mediaEl.removeEventListener("ended", syncPlaying);
    };
  }, [mediaEl]);

  useEffect(() => {
    if (!mediaRef.current || seekRequestMs === null) {
      return;
    }

    mediaRef.current.currentTime = seekRequestMs / 1000;
    mediaRef.current.play().catch(() => undefined);
    onSeekHandled();
  }, [onSeekHandled, seekRequestMs]);

  const activeSegment = useMemo(
    () => segments.find((segment) => segment.id === activeSegmentId) ?? null,
    [activeSegmentId, segments],
  );

  function attachMedia(node: HTMLAudioElement | HTMLVideoElement | null) {
    mediaRef.current = node;
    setMediaEl(node);
  }

  function seekToSegment(segment: TranscriptSegment) {
    if (mediaRef.current) {
      mediaRef.current.currentTime = segment.startMs / 1000;
      mediaRef.current.play().catch(() => undefined);
    }
    syncActiveSegment(segment.startMs / 1000);
    onLocateSegment?.(segment);
  }

  if (!mediaUrl) {
    return (
      <section className="media-transport media-transport--empty" aria-label="Recording playback">
        <InlineNotice tone="info">
          {mediaDenialReason ?? "Media playback is unavailable for this recording."}
        </InlineNotice>
      </section>
    );
  }

  const currentSegmentLabel = activeSegment
    ? `Current segment: ${segments.findIndex((segment) => segment.id === activeSegment.id) + 1} - ${formatSegmentWindow(activeSegment.startMs, activeSegment.endMs)}`
    : "Current segment: none";

  function syncActiveSegment(currentTimeSeconds: number) {
    const currentMs = currentTimeSeconds * 1000;
    const match =
      segments.find(
        (segment) => currentMs >= segment.startMs && currentMs < segment.endMs,
      ) ?? null;
    onActiveSegmentChange(match?.id ?? null);
  }

  function togglePlayback() {
    const media = mediaRef.current;
    if (!media) {
      return;
    }
    if (media.paused || media.ended) {
      media.play().catch(() => undefined);
    } else {
      media.pause();
    }
  }

  function jumpBack() {
    if (!mediaRef.current) {
      return;
    }

    mediaRef.current.currentTime = Math.max(0, mediaRef.current.currentTime - 10);
    syncActiveSegment(mediaRef.current.currentTime);
  }

  function changeRate(nextRate: string) {
    setRate(nextRate);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = Number(nextRate);
    }
  }

  return (
    <section className="media-transport" aria-label="Recording playback" role="group">
      <div className="media-transport__controls">
        {mediaKind === "audio" && mediaUrl ? (
          <WaveScrubber
            activeSegmentId={activeSegmentId}
            media={mediaEl}
            mediaUrl={mediaUrl}
            onReady={handleWaveReady}
            onSeekToSegment={seekToSegment}
            onUnavailable={handleWaveUnavailable}
            segments={segments}
          />
        ) : null}
        {mediaKind === "video" ? (
          <video
            controls
            onTimeUpdate={(event) => syncActiveSegment(event.currentTarget.currentTime)}
            ref={attachMedia}
            src={mediaUrl}
          />
        ) : (
          <audio
            controls={nativeControls || undefined}
            onTimeUpdate={(event) => syncActiveSegment(event.currentTarget.currentTime)}
            preload="metadata"
            ref={attachMedia}
            src={mediaUrl}
          />
        )}
      </div>
      {segments.length > 0 ? (
        <ol aria-label="Transcript segments" className="media-transport__rail">
          {segments.map((segment, index) => {
            const active = segment.id === activeSegmentId;
            const windowLabel = formatSegmentWindow(segment.startMs, segment.endMs);
            return (
              <li key={segment.id}>
                <button
                  aria-current={active ? "true" : undefined}
                  aria-label={`Segment ${index + 1}, ${windowLabel}, ${segment.speakerLabel}. Seek and review.`}
                  className="media-transport__rail-chip"
                  data-active={active || undefined}
                  onClick={() => seekToSegment(segment)}
                  type="button"
                >
                  <span className="media-transport__rail-chip-index">{index + 1}</span>
                  <span className="media-transport__rail-chip-window">{windowLabel}</span>
                  <span className="media-transport__rail-chip-speaker">{segment.speakerLabel}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      <div className="media-transport__actions">
        <button
          aria-pressed={playing}
          className="button button-primary"
          data-testid="transport-play-toggle"
          onClick={togglePlayback}
          type="button"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button className="button button-secondary" onClick={jumpBack} type="button">
          Jump back 10 seconds
        </button>
        <label className="field media-transport__rate-field">
          <span className="field-label">Playback rate</span>
          <select aria-label="Playback rate" onChange={(event) => changeRate(event.currentTarget.value)} value={rate}>
            {PLAYBACK_RATES.map((value) => (
              <option key={value} value={value}>
                {value}x
              </option>
            ))}
          </select>
        </label>
        <span className="media-transport__segment-label">{currentSegmentLabel}</span>
      </div>
    </section>
  );
}
