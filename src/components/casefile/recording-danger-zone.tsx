"use client";

import { useRef, useState, useTransition } from "react";

import { deleteRecordingAction } from "@/server/actions/administration-actions";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Modal } from "@/components/ui/modal";

// demo-recording-remove: admin-only permanent deletion UI, mounted on the
// casefile only for admin_oversight. The typed-confirm phrase is the exact
// recording title, and the server re-checks it - the gate cannot be skipped
// with a crafted request. Deletion details (what dies, what survives) are
// spelled out here so the captain sees the ledger contract up front.
export function RecordingDangerZone({
  recordingId,
  title,
}: {
  recordingId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const matches = confirmText.trim() === title;

  return (
    <section aria-labelledby="danger-zone-heading" className="danger-zone">
      <h2 className="danger-zone__title" id="danger-zone-heading">
        Danger zone
      </h2>
      <p className="danger-zone__note">
        Permanently deletes this recording and its entire casefile, leaving exactly one
        deletion record in the audit ledger - this cannot be undone and is admin-only.
      </p>
      <div className="button-row">
        <button
          className="button button-danger"
          onClick={() => {
            setConfirmText("");
            setError(null);
            setOpen(true);
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
          type="button"
        >
          Delete recording permanently...
        </button>
      </div>

      <Modal
        onClose={() => {
          if (!pending) {
            setOpen(false);
          }
        }}
        open={open}
        title="Delete this recording permanently?"
      >
        <div className="stack-tight">
          <p>
            This deletes <strong>{title}</strong> and its whole casefile: revisions, segments,
            decisions, assignments, ledger rows, jobs, and the media file. Nothing here can be
            undone. One deletion record survives in the audit ledger.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="danger-zone-confirm">
              Type the recording title to confirm
            </label>
            <input
              autoComplete="off"
              id="danger-zone-confirm"
              onChange={(event) => setConfirmText(event.currentTarget.value)}
              placeholder={title}
              ref={inputRef}
              type="text"
              value={confirmText}
            />
            <span className="field-note">Caps matter. The title is the confirmation phrase.</span>
          </div>

          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

          <div className="button-row modal-actions-row">
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() => setOpen(false)}
              type="button"
            >
              Keep the recording
            </button>
            <button
              className="button button-danger"
              disabled={!matches || pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await deleteRecordingAction({
                    recordingId,
                    expectedTitle: confirmText.trim(),
                  });
                  if (!result.ok) {
                    setError(
                      result.message ??
                        "Deletion failed. The recording was left untouched; try again or inspect the audit.",
                    );
                    return;
                  }
                  // Navigate OUTSIDE the transition: router.push/refresh inside
                  // this async scope races an RSC refresh of the current page,
                  // which now 404s (the recording is gone) and wedges the
                  // transition pending state forever (captain-caught hang).
                  // A hard navigation unloads the page outright - no race.
                  window.location.assign(result.data.href);
                });
              }}
              type="button"
            >
              {pending ? "Deleting..." : "Delete permanently"}
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
