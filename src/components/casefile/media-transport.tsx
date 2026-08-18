"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import type { Recording, TranscriptSegment } from "@/domain/models";
import { formatSegmentWindow } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";
import { WaveScrubber } from "@/components/casefile/wave-scrubber";
import {
  centeredHorizontalScrollLeft,
  decideFollowScroll,
  isTargetInHorizontalView,
} from "./follow-scroll";

type MediaTransportProps = {
  mediaKind: Recording["mediaKind"];
  mediaUrl: string | null;
  mediaDenialReason?: string | null;
  segments: TranscriptSegment[];
  activeSegmentId: string | null;
  /**
   * Transcript-initiated click on one segment. Clicking any segment other
   * than the active one seeks to its start and plays (segment-play-toggle
   * keeps that). Clicking the ACTIVE segment toggles instead: pause when it
   * is playing, resume from the paused position (no re-seek) when it is not.
   */
  seekRequest: { segmentId: string; startMs: number; endMs: number } | null;
  onSeekHandled: () => void;
  onMediaSeek?: () => void;
  /**
   * First playback tick gate (casefile-pin-transcript-zone): fired on each
   * timeupdate while the media is actually playing, so the transcript's
   * dormant-on-mount follow activates exactly when the track starts moving.
   */
  onPlaybackTick?: () => void;
  onActiveSegmentChange: (segmentId: string | null) => void;
  /** Mirrors the media element's playing state so the transcript document
   * renders the active segment button as a truthful play/pause toggle. */
  onPlayingChange?: (playing: boolean) => void;
  /**
   * Segment rail: seek to this segment and surface it inline in the
   * transcript list (opens its review affordance when the caller can edit).
   */
  onLocateSegment?: (segment: TranscriptSegment) => void;
};

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

function segmentAtTime(segments: TranscriptSegment[], currentTimeSeconds: number) {
  const currentMs = currentTimeSeconds * 1000;
  return (
    segments.find(
      (segment) => currentMs >= segment.startMs && currentMs < segment.endMs,
    ) ?? null
  );
}

export function MediaTransport({
  mediaKind,
  mediaUrl,
  mediaDenialReason = null,
  segments,
  activeSegmentId,
  seekRequest,
  onSeekHandled,
  onMediaSeek,
  onPlaybackTick,
  onActiveSegmentChange,
  onLocateSegment,
  onPlayingChange,
}: MediaTransportProps) {
  const transportRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLOListElement | null>(null);
  // Wave-track scroll sync: the rail is an independent horizontal scrollport
  // that follows the same active segment the transcript centers. It runs the
  // transcript's non-fighting contract on the inline axis: a user wheel or
  // touch drag on the rail pauses ONLY the rail's follow; rail gestures
  // never pause the transcript's vertical follow
  // (FOLLOW_SCROLL_IGNORED_TARGETS), and any explicit seek re-engages both
  // axes. The nonce mirrors the workspace's followActivationNonce so a repeated
  // seek that does not change the active segment still re-centers the chip.
  const railFollowPausedRef = useRef(false);
  const [railFollowResumeNonce, setRailFollowResumeNonce] = useState(0);
  const [railWidth, setRailWidth] = useState(0);
  const hasRail = Boolean(mediaUrl) && segments.length > 0;
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

  useEffect(() => {
    const transport = transportRef.current;
    if (!transport) {
      return;
    }

    const page = transport.closest<HTMLElement>(".casefile-page");
    const root = document.documentElement;
    const previousPageClearance = page?.style.getPropertyValue("--player-clearance") ?? "";
    const previousRootClearance = root.style.getPropertyValue("--player-clearance");
    const updateClearance = () => {
      const height = Math.ceil(transport.getBoundingClientRect().height);
      if (height <= 0) {
        return;
      }
      const value = `${height}px`;
      page?.style.setProperty("--player-clearance", value);
      root.style.setProperty("--player-clearance", value);
    };

    updateClearance();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateClearance);
    observer?.observe(transport);

    return () => {
      observer?.disconnect();
      if (page) {
        if (previousPageClearance) {
          page.style.setProperty("--player-clearance", previousPageClearance);
        } else {
          page.style.removeProperty("--player-clearance");
        }
      }
      if (previousRootClearance) {
        root.style.setProperty("--player-clearance", previousRootClearance);
      } else {
        root.style.removeProperty("--player-clearance");
      }
    };
  }, []);

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

  // Keep the transcript document's active-segment toggle truthful: the
  // exposed aria-pressed on that button tracks this same state.
  useEffect(() => {
    onPlayingChange?.(playing);
  }, [onPlayingChange, playing]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || seekRequest === null) {
      return;
    }

    const currentSegment = segmentAtTime(segments, media.currentTime);

    if (currentSegment?.id === seekRequest.segmentId) {
      syncActiveSegment(media.currentTime);
      // Active-segment click: play/pause toggle (segment-play-toggle).
      // Resume keeps the paused currentTime untouched, so no re-seek jump
      // is audible or visible; pause is the equivalent of the transport
      // pause button, just without scrolling up to it.
      if (media.paused || media.ended) {
        media.play().catch(() => undefined);
      } else {
        media.pause();
      }
    } else {
      // Any other segment keeps the original seek-and-play contract.
      media.currentTime = seekRequest.startMs / 1000;
      media.play().catch(() => undefined);
      syncActiveSegment(seekRequest.startMs / 1000);
    }
    onSeekHandled();
  }, [onSeekHandled, seekRequest, segments]);

  const activeSegment = useMemo(
    () => segments.find((segment) => segment.id === activeSegmentId) ?? null,
    [activeSegmentId, segments],
  );
  const railLayoutSignature = useMemo(
    () =>
      JSON.stringify(
        segments.map((segment) => [
          segment.startMs,
          segment.endMs,
          segment.speakerLabel,
        ]),
      ),
    [segments],
  );

  function attachMedia(node: HTMLAudioElement | HTMLVideoElement | null) {
    mediaRef.current = node;
    setMediaEl(node);
  }

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) {
      return;
    }
    // User scroll gestures on the strip itself pause the horizontal follow.
    // Programmatic follow scrolls never fire these events, so follow cannot
    // pause itself - the same boundary the vertical contract documents.
    const pauseRailFollow = () => {
      railFollowPausedRef.current = true;
    };
    rail.addEventListener("wheel", pauseRailFollow, { passive: true });
    rail.addEventListener("touchmove", pauseRailFollow, { passive: true });
    return () => {
      rail.removeEventListener("wheel", pauseRailFollow);
      rail.removeEventListener("touchmove", pauseRailFollow);
    };
  }, [hasRail]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) {
      return;
    }
    const updateRailWidth = () => {
      const nextWidth = rail.clientWidth;
      setRailWidth((currentWidth) =>
        currentWidth === nextWidth ? currentWidth : nextWidth,
      );
    };

    updateRailWidth();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateRailWidth);
    observer?.observe(rail);
    return () => observer?.disconnect();
  }, [hasRail]);

  // Horizontal playback follow: keep the active segment's chip centered-ish
  // in the rail scrollport as playback advances and after explicit seeks.
  // Vertical scrollports are deliberately untouched here (direct scrollLeft
  // writes, never scrollIntoView) so the rail cannot nudge the page or the
  // transcript's bounded scrollport.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || !activeSegmentId) {
      return;
    }
    const chip = rail.querySelector<HTMLElement>("[data-active]");
    if (!chip) {
      return;
    }

    const railRect = rail.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const scrollport = { clientWidth: rail.clientWidth, scrollLeft: rail.scrollLeft };
    const target = {
      // rects are viewport-relative; add the current scroll back to reach
      // the content-origin coordinates the helper contract requires.
      offsetLeft: chipRect.left - railRect.left + rail.scrollLeft,
      width: chipRect.width,
    };

    const decision = decideFollowScroll(
      true,
      railFollowPausedRef.current,
      isTargetInHorizontalView(scrollport, target),
    );
    if (decision === "skip") {
      return;
    }
    railFollowPausedRef.current = false;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rail.scrollTo({
      left: centeredHorizontalScrollLeft(scrollport, target),
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeSegmentId, railFollowResumeNonce, railLayoutSignature, railWidth]);

  function resumeRailFollow() {
    railFollowPausedRef.current = false;
    setRailFollowResumeNonce((current) => current + 1);
  }

  function seekToSegment(segment: TranscriptSegment) {
    if (mediaRef.current) {
      mediaRef.current.currentTime = segment.startMs / 1000;
      mediaRef.current.play().catch(() => undefined);
    }
    syncActiveSegment(segment.startMs / 1000);
    // Rail chips and wave markers are explicit seeks: they re-engage the
    // horizontal follow just like they re-engage the transcript's follow
    // via onMediaSeek.
    resumeRailFollow();
    onLocateSegment?.(segment);
  }

  if (!mediaUrl) {
    return (
      <section
        aria-label="Recording playback"
        className="media-transport media-transport--empty"
        ref={transportRef}
      >
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
    const match = segmentAtTime(segments, currentTimeSeconds);
    onActiveSegmentChange(match?.id ?? null);
  }

  function handleTimeUpdate(event: SyntheticEvent<HTMLMediaElement>) {
    syncActiveSegment(event.currentTarget.currentTime);
    if (!event.currentTarget.paused) {
      onPlaybackTick?.();
    }
  }

  function handleSeeking(event: SyntheticEvent<HTMLMediaElement>) {
    syncActiveSegment(event.currentTarget.currentTime);
    // Shared media seeks (wave click/drag, native controls, transcript
    // timestamps, jump-back) are explicit seeks on both axes.
    resumeRailFollow();
    onMediaSeek?.();
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
    <section
      aria-label="Recording playback"
      className="media-transport"
      ref={transportRef}
      role="group"
    >
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
            onSeeking={handleSeeking}
            onTimeUpdate={handleTimeUpdate}
            ref={attachMedia}
            src={mediaUrl}
          />
        ) : (
          <audio
            controls={nativeControls || undefined}
            onSeeking={handleSeeking}
            onTimeUpdate={handleTimeUpdate}
            preload="metadata"
            ref={attachMedia}
            src={mediaUrl}
          />
        )}
      </div>
      {segments.length > 0 ? (
        <ol aria-label="Transcript segments" className="media-transport__rail" ref={railRef}>
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
