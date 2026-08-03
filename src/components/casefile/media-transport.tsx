"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Recording, TranscriptSegment } from "@/domain/models";
import { formatSegmentWindow } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";

type MediaTransportProps = {
  mediaKind: Recording["mediaKind"];
  mediaUrl: string | null;
  mediaDenialReason?: string | null;
  segments: TranscriptSegment[];
  activeSegmentId: string | null;
  seekRequestMs: number | null;
  onSeekHandled: () => void;
  onActiveSegmentChange: (segmentId: string | null) => void;
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
}: MediaTransportProps) {
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const [rate, setRate] = useState("1");

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
        (segment) => currentMs >= segment.startMs && currentMs <= segment.endMs,
      ) ?? null;
    onActiveSegmentChange(match?.id ?? null);
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
        {mediaKind === "video" ? (
          <video
            controls
            onTimeUpdate={(event) => syncActiveSegment(event.currentTarget.currentTime)}
            ref={attachMedia}
            src={mediaUrl}
          />
        ) : (
          <audio
            controls
            onTimeUpdate={(event) => syncActiveSegment(event.currentTarget.currentTime)}
            ref={attachMedia}
            src={mediaUrl}
          />
        )}
      </div>
      <div className="media-transport__actions">
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
