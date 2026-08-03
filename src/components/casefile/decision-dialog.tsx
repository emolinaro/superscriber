"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateTimeUtc } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Modal } from "@/components/ui/modal";

export type DecisionKind = "submit" | "withdraw" | "requestChanges" | "approve" | "reopen";

export type DecisionDialogResult =
  | { ok: true }
  | {
      ok: false;
      error?: string | null;
    };

export type DecisionDialogRevision = {
  version: number;
  submittedByDisplay: string | null;
  submittedAt: string | null;
  approvedAt?: string | null;
  segments?: Array<{ id: string }> | null;
};

const FINAL_LABELS: Record<DecisionKind, string> = {
  submit: "Submit for approval",
  withdraw: "Withdraw revision",
  requestChanges: "Request changes",
  approve: "Approve and complete work",
  reopen: "Reopen as draft",
};

const COPY: Record<DecisionKind, string> = {
  submit:
    "Submit the current draft for approval. You will stop editing until the revision returns to draft review.",
  withdraw:
    "Withdrawing returns the pending revision to an editable draft for the original submitter.",
  requestChanges:
    "Requesting changes returns the revision to draft review and keeps the current approval blocked.",
  approve:
    "Approving completes the current work and locks the approved transcript under policy.",
  reopen: "Reopening creates a new editable draft cycle from the active approved revision.",
};

function needsReason(kind: DecisionKind) {
  return kind === "withdraw" || kind === "requestChanges" || kind === "reopen";
}

function canSubmit(kind: DecisionKind, reason: string, note: string) {
  const trimmedReason = reason.trim();
  const trimmedNote = note.trim();

  if (needsReason(kind)) {
    return trimmedReason.length >= 10 && trimmedReason.length <= 500;
  }

  if (kind === "approve") {
    return trimmedNote.length <= 500;
  }

  return true;
}

export function DecisionDialog({
  kind,
  onCancel,
  onConfirm,
  open,
  revision,
}: {
  kind: DecisionKind;
  onCancel: () => void;
  onConfirm: (input: { reason: string; note: string }) => Promise<DecisionDialogResult> | DecisionDialogResult;
  open: boolean;
  revision: DecisionDialogRevision;
}) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setReason("");
    setNote("");
    setPending(false);
    setError(null);
  }, [kind, open, revision.version]);

  const valid = useMemo(() => canSubmit(kind, reason, note), [kind, note, reason]);
  const segmentCount = revision.segments?.length ?? 0;
  const submittedAtLabel = revision.submittedAt
    ? formatDateTimeUtc(revision.submittedAt)
    : "Not yet submitted";
  const submittedByLabel = revision.submittedByDisplay ?? "Not yet submitted";

  async function handleConfirm() {
    if (!valid || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const result = await onConfirm({ reason, note });
      if (!result.ok) {
        setError(result.error ?? null);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      onClose={() => {
        if (!pending) {
          onCancel();
        }
      }}
      open={open}
      title={FINAL_LABELS[kind]}
    >
      <div className="button-row modal-actions-row">
        <button className="button button-secondary" onClick={onCancel} type="button">
          Close
        </button>
      </div>

      <div className="casefile-decision-dialog__facts">
        <p>Revision v{revision.version}</p>
        <p>Submitted by {submittedByLabel}</p>
        <p>Submitted at {submittedAtLabel}</p>
        <p>Segments {segmentCount}</p>
      </div>

      <p>{COPY[kind]}</p>

      {needsReason(kind) ? (
        <div className="field">
          <label className="field-label" htmlFor="casefile-decision-reason">
            Reason
          </label>
          <textarea
            id="casefile-decision-reason"
            maxLength={500}
            minLength={10}
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
          <div className="field-note-row">
            <span className="field-note">10-500 characters required.</span>
            <span className="field-note">{reason.length}/500</span>
          </div>
        </div>
      ) : null}

      {kind === "approve" ? (
        <div className="field">
          <label className="field-label" htmlFor="casefile-decision-note">
            Approval note, optional
          </label>
          <textarea
            id="casefile-decision-note"
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            value={note}
          />
          <div className="field-note-row">
            <span className="field-note">Up to 500 characters.</span>
            <span className="field-note">{note.length}/500</span>
          </div>
        </div>
      ) : null}

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <div className="button-row">
        <button className="button button-secondary" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="button button-primary"
          disabled={!valid || pending}
          onClick={() => {
            void handleConfirm();
          }}
          type="button"
        >
          {pending ? "Working..." : FINAL_LABELS[kind]}
        </button>
      </div>
    </Modal>
  );
}
