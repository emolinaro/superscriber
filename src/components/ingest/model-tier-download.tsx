"use client";

import { useEffect, useId, useRef, useState } from "react";

import { formatBytes } from "./transfer-progress";

// model-tier-provisioning: the picker's per-tier download action. Idle tiers
// get a one-click button with the pinned size on it; a running tier swaps the
// button for a live progress readout; a failed tier keeps the server error on
// screen next to a retry. Rendered only for admin principals outside
// phone-safety mode (the parent owns that gate), and the server re-checks the
// gate on every start.

export type TierDownloadView = {
  state: "idle" | "downloading" | "completed" | "failed";
  bytesReceived: number;
  bytesTotal: number;
  error: string | null;
};

export function ModelTierDownloadAction({
  tierId,
  sizeBytes,
  view,
  startError,
  busy,
  onStart,
}: {
  tierId: string;
  sizeBytes: number;
  view: TierDownloadView | null;
  startError: string | null;
  busy: boolean;
  onStart: () => void;
}) {
  const detailId = useId();

  // Poll-by-poll text would chatter on a screen reader; announce only the
  // 10-percent steps and completion, mirroring the upload transfer surface.
  const announcementBoundaryRef = useRef(-1);
  const [announcement, setAnnouncement] = useState("");
  const downloadingBytes = view?.state === "downloading" ? view.bytesReceived : null;
  const downloadingTotal = view?.state === "downloading" ? view.bytesTotal : null;
  useEffect(() => {
    if (downloadingBytes === null) {
      return;
    }
    const total = downloadingTotal && downloadingTotal > 0 ? downloadingTotal : sizeBytes;
    const percent = total > 0 ? (downloadingBytes / total) * 100 : 0;
    if (percent >= 100 && announcementBoundaryRef.current < 100) {
      announcementBoundaryRef.current = 100;
      setAnnouncement(`${tierId} download complete.`);
      return;
    }
    const boundary = Math.floor(percent / 10) * 10;
    if (boundary >= 10 && boundary > announcementBoundaryRef.current) {
      announcementBoundaryRef.current = boundary;
      setAnnouncement(`${boundary} percent of the ${tierId} model downloaded.`);
    }
  }, [downloadingBytes, downloadingTotal, sizeBytes, tierId]);

  if (view?.state === "downloading") {
    const total = view.bytesTotal > 0 ? view.bytesTotal : sizeBytes;
    return (
      <span className="ingest-model-download" data-testid={`model-download-${tierId}`}>
        <progress
          aria-describedby={`${detailId}-detail`}
          aria-label={`Downloading ${tierId} model`}
          max={total}
          value={view.bytesReceived}
        />
        <span className="field-note" id={`${detailId}-detail`} aria-hidden="true">
          Downloading {tierId}: {formatBytes(view.bytesReceived)} of {formatBytes(total)}
        </span>
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>
      </span>
    );
  }

  return (
    <span className="ingest-model-download" data-testid={`model-download-${tierId}`}>
      {view?.state === "failed" ? (
        <span className="field-error-message" role="alert">
          {`Download of ${tierId} failed${view.error ? `: ${view.error}` : "."}`}
        </span>
      ) : null}
      {startError ? (
        <span className="field-error-message" role="alert">
          {startError}
        </span>
      ) : null}
      <button
        className="button button-secondary interactive-target"
        disabled={busy}
        onClick={onStart}
        type="button"
      >
        {view?.state === "failed" ? `Retry download ${tierId}` : `Download ${tierId}`} (
        {formatBytes(sizeBytes)})
      </button>
    </span>
  );
}
