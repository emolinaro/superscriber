"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  md: "Readable Markdown with speaker labels and exact segment timings.",
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
  approvalDecisions,
  onAnnouncement,
  onClose,
  onSessionRecoveryRequested,
  open,
  recordingId,
  revision,
  revisionOptions,
  hasApprovedRevision,
}: {
  actionModeId: string | null;
  approvalDecisions: Array<{
    revisionId: string;
    state: string;
    actorDisplay: string;
  }>;
  onAnnouncement: (message: string) => void;
  onClose: () => void;
  onSessionRecoveryRequested: () => void;
  open: boolean;
  recordingId: string;
  revision: { version: number; id: string } | null;
  /** Version history (demo-governance-bringback): revision picker for the
     export surface. */
  revisionOptions: Array<{
    id: string;
    version: number;
    state: string;
    stateLabel: string;
    approvedAt: string | null;
  }>;
  /** Export affordance (demo-governance-bringback): honest empty state when
     nothing is approved yet. */
  hasApprovedRevision: boolean;
}) {
  const [pendingFormat, setPendingFormat] = useState<ApprovedTranscriptExportFormat | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<ApprovedTranscriptExportFormat | null>(null);
  const approvedDefault =
    revisionOptions.find((option) => option.state === "approved")?.id
    ?? revision?.id
    ?? revisionOptions[0]?.id
    ?? "";
  const [selectedRevisionId, setSelectedRevisionId] = useState(approvedDefault);
  const [error, setError] = useState<string | null>(null);
  const buttonRefs = useRef(new Map<ApprovedTranscriptExportFormat, HTMLButtonElement>());
  const pendingRef = useRef(false);
  const isPending = pendingFormat !== null;
  const selectedRevision =
    revisionOptions.find((option) => option.id === selectedRevisionId) ?? null;
  const selectedApprovalDecision = approvalDecisions.find(
    (decision) =>
      decision.revisionId === selectedRevisionId && decision.state === "approved",
  );
  const selectedIsApproved = selectedRevision?.state === "approved";
  const metadataCopy = useMemo(() => {
    if (!selectedRevision) {
      return "No revision exists yet for this casefile.";
    }

    if (!selectedIsApproved) {
      return "This revision is not the approved record; its export is still attributed in the audit.";
    }

    if (selectedApprovalDecision) {
      return `${selectedApprovalDecision.actorDisplay} approved revision v${selectedRevision.version}.`;
    }

    if (selectedRevision.approvedAt) {
      return `Legacy approval metadata is incomplete for revision v${selectedRevision.version}. Approved at ${formatDateTimeUtc(selectedRevision.approvedAt)}.`;
    }

    return "Legacy approval metadata is incomplete for this revision.";
  }, [selectedApprovalDecision, selectedIsApproved, selectedRevision]);

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
      pendingRef.current = false;
      setPendingFormat(null);
      setSelectedFormat(null);
      setError(null);
      setSelectedRevisionId(approvedDefault);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    if (pendingRef.current) {
      return;
    }

    onClose();
  }, [onClose]);

  async function handleExport(format: ApprovedTranscriptExportFormat) {
    if (pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    setSelectedFormat(format);
    setPendingFormat(format);
    setError(null);

    try {
      const exportUrl =
        buildApprovedTranscriptExportUrl(
          `/api/recordings/${recordingId}/transcript`,
          format,
          actionModeId,
        ) + `&revisionId=${encodeURIComponent(selectedRevisionId)}`;

      const response = await fetch(exportUrl);

      if (!response.ok) {
        if (response.status === 401) {
          onSessionRecoveryRequested();
        } else if (response.status === 403) {
          const serverMessage = (await response.text()).trim();
          setError(
            `${serverMessage ? `${serverMessage} ` : "Export is not allowed under the current authority. "}Administrators: enter the matching action mode first, then retry the download - attribution stays intact.`,
          );
        } else if (response.status === 409) {
          setError("This casefile no longer has an active approved revision.");
        } else {
          setError("Export could not be prepared. Try again.");
        }
        return;
      }

      const blob = await response.blob();
      triggerObjectUrlDownload(blob, fileNameFromDisposition(response.headers, format));
      const exportedVersion =
        revisionOptions.find((option) => option.id === selectedRevisionId)?.version
        ?? revision?.version;
      onAnnouncement(`Revision v${exportedVersion} exported as ${format.toUpperCase()}.`);
      onClose();
    } catch {
      setError("Export could not be prepared. Try again.");
    } finally {
      pendingRef.current = false;
      setPendingFormat(null);
    }
  }

  return (
    <Modal
      backdropClassName="export-backdrop"
      backdropTestId="export-backdrop"
      onClose={handleClose}
      open={open}
      surfaceClassName="export-dialog"
      title="Export approved transcript"
    >
      <div className="button-row modal-actions-row">
        <button className="button button-secondary" disabled={isPending} onClick={handleClose} type="button">
          Close
        </button>
      </div>

      {hasApprovedRevision ? null : (
        <InlineNotice tone="info">
          No approved revision yet - the default export target (approved transcript) unlocks
          once a revision is approved. Revision snapshots below remain exportable under the
          usual authority and stay attributed in the audit.
        </InlineNotice>
      )}

      <div className="stack-tight export-dialog__meta">
        <p>
          {selectedRevision
            ? selectedIsApproved
              ? `Approved revision v${selectedRevision.version}`
              : `Revision v${selectedRevision.version} (${selectedRevision.stateLabel})`
            : "No revision exists yet for this casefile."}
        </p>
        <p>{metadataCopy}</p>
        <div className="field">
          <label className="field-label" htmlFor="export-revision">
            Revision to export
          </label>
          <select
            id="export-revision"
            onChange={(event) => setSelectedRevisionId(event.currentTarget.value)}
            value={selectedRevisionId}
          >
            {revisionOptions.map((option) => (
              <option key={option.id} value={option.id}>
                v{option.version} · {option.stateLabel}
              </option>
            ))}
          </select>
          <span className="field-note">
            Defaults to the approved revision; archived exports are attributed identically in
            the audit event.
          </span>
        </div>
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
