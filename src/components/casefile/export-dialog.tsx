"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS,
  type ApprovedTranscriptExportFormat,
  buildApprovedTranscriptExportUrl,
} from "@/lib/approved-transcript-export";
import { formatDateTimeUtc } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Modal } from "@/components/ui/modal";

const FORMAT_DESCRIPTIONS: Record<ApprovedTranscriptExportFormat, string> = {
  docx: "Formatted handoff for policy-approved document editing.",
  txt: "Plain text export for simple archival or handoff.",
  srt: "Subtitle cues with numbered timestamps for timed playback.",
  vtt: "Web caption cues for browser and streaming workflows.",
  csv: "Spreadsheet-ready rows for segment-by-segment analysis.",
  tsv: "Tab-separated rows for safer spreadsheet ingestion.",
  json: "Structured transcript data for system-to-system exchange.",
};

function fileNameFromDisposition(headers: Headers, format: ApprovedTranscriptExportFormat) {
  return /filename="([^"]+)"/.exec(headers.get("content-disposition") ?? "")?.[1]
    ?? `approved-transcript.${format}`;
}

function triggerObjectUrlDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function ExportDialog({
  actionModeId,
  approvedAt,
  approvedBy,
  onAnnouncement,
  onClose,
  onSessionRecoveryRequested,
  open,
  recordingId,
  revision,
}: {
  actionModeId: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  onAnnouncement: (message: string) => void;
  onClose: () => void;
  onSessionRecoveryRequested: () => void;
  open: boolean;
  recordingId: string;
  revision: { version: number };
}) {
  const [pendingFormat, setPendingFormat] = useState<ApprovedTranscriptExportFormat | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<ApprovedTranscriptExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRefs = useRef(new Map<ApprovedTranscriptExportFormat, HTMLButtonElement>());
  const metadataCopy = useMemo(() => {
    if (approvedBy) {
      return `${approvedBy} approved revision v${revision.version}.`;
    }

    if (approvedAt) {
      return `Legacy approval metadata is incomplete for revision v${revision.version}. Approved at ${formatDateTimeUtc(approvedAt)}.`;
    }

    return "Legacy approval metadata is incomplete for this revision.";
  }, [approvedAt, approvedBy, revision.version]);

  useEffect(() => {
    if (!error || !selectedFormat) {
      return;
    }

    requestAnimationFrame(() => {
      buttonRefs.current.get(selectedFormat)?.focus();
    });
  }, [error, selectedFormat]);

  useEffect(() => {
    if (!open) {
      setPendingFormat(null);
      setSelectedFormat(null);
      setError(null);
    }
  }, [open]);

  async function handleExport(format: ApprovedTranscriptExportFormat) {
    setSelectedFormat(format);
    setPendingFormat(format);
    setError(null);

    try {
      const response = await fetch(
        buildApprovedTranscriptExportUrl(
          `/api/recordings/${recordingId}/transcript`,
          format,
          actionModeId,
        ),
      );

      if (!response.ok) {
        if (response.status === 401) {
          onSessionRecoveryRequested();
        } else if (response.status === 403) {
          setError("Export is no longer allowed for this account or policy.");
        } else if (response.status === 409) {
          setError("This casefile no longer has an active approved revision.");
        } else {
          setError("Export could not be prepared. Try again.");
        }
        return;
      }

      const blob = await response.blob();
      triggerObjectUrlDownload(blob, fileNameFromDisposition(response.headers, format));
      onAnnouncement(`Approved revision v${revision.version} exported as ${format.toUpperCase()}.`);
      onClose();
    } catch {
      setError("Export could not be prepared. Try again.");
    } finally {
      setPendingFormat(null);
    }
  }

  return (
    <Modal
      backdropClassName="export-backdrop"
      onClose={onClose}
      open={open}
      surfaceClassName="export-dialog"
      title="Export approved transcript"
    >
      <div className="button-row modal-actions-row">
        <button className="button button-secondary" onClick={onClose} type="button">
          Close
        </button>
      </div>

      <div className="stack-tight export-dialog__meta">
        <p>Approved revision v{revision.version}</p>
        <p>{metadataCopy}</p>
      </div>

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <div className="export-group-list">
        {APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS.map((group) => {
          const heading = group.id === "structured" ? "Structured data" : group.label;
          return (
            <section className="export-group" key={group.id}>
              <h3 className="export-group__title">{heading}</h3>
              <div className="export-option-list">
                {group.formats.map((format) => (
                  <button
                    aria-label={format.toUpperCase()}
                    className="button button-secondary export-option"
                    key={format}
                    onClick={() => {
                      void handleExport(format);
                    }}
                    ref={(element) => {
                      if (element) {
                        buttonRefs.current.set(format, element);
                      } else {
                        buttonRefs.current.delete(format);
                      }
                    }}
                    type="button"
                  >
                    <strong>{format.toUpperCase()}</strong>
                    <span>{FORMAT_DESCRIPTIONS[format]}</span>
                    {pendingFormat === format ? <span>Preparing export...</span> : null}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
