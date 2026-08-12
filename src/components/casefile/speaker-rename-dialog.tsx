"use client";

import { useEffect, useMemo, useState } from "react";
import {
  describeSpeakerRename,
  listSpeakers,
  planSpeakerRename,
  SPEAKER_NAME_MAX_LENGTH,
  type SpeakerRenamePlan,
} from "@/domain/speakers";
import type { TranscriptSegment } from "@/domain/models";
import { CasefileCommandError } from "@/server/casefile/errors";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Modal } from "@/components/ui/modal";

export type SpeakerRenameDialogResult =
  | { ok: true }
  | {
      ok: false;
      error?: string | null;
    };

function previewRename(
  segments: TranscriptSegment[],
  fromSpeaker: string,
  toSpeaker: string,
): { plan: SpeakerRenamePlan; error: null } | { plan: null; error: string | null } {
  // The pre-commit summary mirrors the server-side batch plan exactly, so
  // counts shown here are the counts the governed command will write.
  try {
    return { plan: planSpeakerRename(segments, fromSpeaker, toSpeaker), error: null };
  } catch (cause) {
    if (cause instanceof CasefileCommandError) {
      return { plan: null, error: cause.message };
    }

    return { plan: null, error: "Enter a valid speaker name." };
  }
}

export function SpeakerRenameDialog({
  onCancel,
  onConfirm,
  open,
  segments,
}: {
  onCancel: () => void;
  onConfirm: (input: {
    fromSpeaker: string;
    toSpeaker: string;
  }) => Promise<SpeakerRenameDialogResult> | SpeakerRenameDialogResult;
  open: boolean;
  segments: TranscriptSegment[];
}) {
  const speakers = useMemo(() => listSpeakers(segments), [segments]);
  const [fromSpeaker, setFromSpeaker] = useState(speakers[0]?.label ?? "");
  const [toSpeaker, setToSpeaker] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setFromSpeaker(speakers[0]?.label ?? "");
    setToSpeaker("");
    setPending(false);
    setError(null);
  }, [open, speakers]);

  const preview = useMemo(
    () => previewRename(segments, fromSpeaker, toSpeaker),
    [segments, fromSpeaker, toSpeaker],
  );
  const canConfirm = preview.plan !== null && !pending;
  const targetOptions = speakers.filter((speaker) => speaker.label !== fromSpeaker);

  async function handleConfirm() {
    if (!preview.plan || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const result = await onConfirm({
        fromSpeaker: preview.plan.fromSpeaker,
        toSpeaker: preview.plan.toSpeaker,
      });
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
      title="Rename speaker everywhere"
    >
      <div className="stack-tight" data-testid="speaker-rename-dialog">
        <p>
          Rename one speaker across every segment in this draft in a single governed
          step. The previous wording stays in the revision history.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="speaker-rename-from">
            Current speaker
          </label>
          <select
            id="speaker-rename-from"
            onChange={(event) => setFromSpeaker(event.currentTarget.value)}
            value={fromSpeaker}
          >
            {speakers.map((speaker) => (
              <option key={speaker.label} value={speaker.label}>
                {speaker.label} ({speaker.segmentCount}{" "}
                {speaker.segmentCount === 1 ? "segment" : "segments"})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="speaker-rename-to">
            New speaker name
          </label>
          <input
            id="speaker-rename-to"
            list="speaker-rename-existing"
            maxLength={SPEAKER_NAME_MAX_LENGTH}
            onChange={(event) => setToSpeaker(event.currentTarget.value)}
            type="text"
            value={toSpeaker}
          />
          <datalist id="speaker-rename-existing">
            {targetOptions.map((speaker) => (
              <option key={speaker.label} value={speaker.label} />
            ))}
          </datalist>
          <span className="field-note">
            Picking an existing speaker merges both names onto it.
          </span>
        </div>

        {preview.plan ? (
          <p className="field-note" data-testid="speaker-rename-summary">
            {describeSpeakerRename(preview.plan)}
          </p>
        ) : null}
        {preview.error ? <InlineNotice tone="warning">{preview.error}</InlineNotice> : null}

        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        <div className="button-row">
          <button className="button button-secondary" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={!canConfirm}
            onClick={() => {
              void handleConfirm();
            }}
            type="button"
          >
            {pending ? "Renaming..." : "Rename speaker"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
