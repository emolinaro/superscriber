import { useId } from "react";

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function nextProgressAnnouncement(previousBoundary: number, nextPercent: number) {
  if (previousBoundary < 0) {
    return { boundary: 0, message: "Upload started." };
  }
  if (nextPercent >= 100 && previousBoundary < 100) {
    return { boundary: 100, message: "Upload complete." };
  }

  const boundary = Math.floor(nextPercent / 10) * 10;
  return boundary >= 10 && boundary > previousBoundary
    ? { boundary, message: `${boundary} percent uploaded.` }
    : null;
}

export function TransferProgress({
  announcement,
  bytesExpected,
  bytesReceived,
  detail,
  statusLabel,
}: {
  announcement: string;
  bytesExpected: number;
  bytesReceived: number;
  detail?: string;
  statusLabel: string;
}) {
  const detailId = useId();

  return (
    <section className="ingest-transfer-card" aria-labelledby={detailId} data-testid="transfer-progress">
      <div className="status-row">
        <strong id={detailId}>Transfer</strong>
        <span className="badge">{statusLabel}</span>
      </div>
      <progress
        aria-describedby={`${detailId}-detail`}
        aria-label="Upload progress"
        max={Math.max(bytesExpected, 1)}
        value={bytesReceived}
      />
      <p className="field-note" id={`${detailId}-detail`}>
        {detail ?? `${formatBytes(bytesReceived)} of ${formatBytes(bytesExpected)} committed`}
      </p>
      <p aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
    </section>
  );
}
