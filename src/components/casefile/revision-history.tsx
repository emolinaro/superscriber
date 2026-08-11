"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { TranscriptSegment } from "@/domain/models";
import { Modal } from "@/components/ui/modal";
import { InlineNotice } from "@/components/ui/inline-notice";
import { formatSegmentWindow } from "@/lib/format";
import { appendQueryMessages } from "@/lib/navigation-path";
import { recoverRevisionAction } from "@/server/actions/administration-actions";
import type { CasefileRevisionViewModel, CasefileViewModel } from "@/server/casefile/read-model";

function buildRecordingHref(recordingId: string, revisionId?: string | null) {
  if (!revisionId) {
    return `/recordings/${recordingId}`;
  }

  return `/recordings/${recordingId}?revision=${encodeURIComponent(revisionId)}`;
}

type DiffMarker = "same" | "changed" | "added" | "removed";

function diffSegments(
  current: TranscriptSegment[],
  archived: TranscriptSegment[],
): Array<{ index: number; marker: DiffMarker; before?: TranscriptSegment; after?: TranscriptSegment }> {
  const count = Math.max(current.length, archived.length);
  const rows: Array<{ index: number; marker: DiffMarker; before?: TranscriptSegment; after?: TranscriptSegment }> = [];
  for (let index = 0; index < count; index += 1) {
    const after = current[index];
    const before = archived[index];
    if (!before) {
      rows.push({ index, marker: "added", after });
    } else if (!after) {
      rows.push({ index, marker: "removed", before });
    } else if (before.text === after.text && before.speakerLabel === after.speakerLabel) {
      rows.push({ index, marker: "same", before, after });
    } else {
      rows.push({ index, marker: "changed", before, after });
    }
  }
  return rows;
}

const MARKER_LABEL: Record<DiffMarker, string> = {
  same: "Same",
  changed: "Changed",
  added: "Added",
  removed: "Removed",
};

/**
 * demo-version-history + demo-diff-highlights foundation: the Revisions tab
 * lists the full lineage, each archived row can open as a read-only snapshot
 * (deep link) or diff against the active revision inline, and an admin can
 * RECOVER any row into a new active draft (provenance preserved in the new
 * draft's summary; the audit trail records actor + from-version).
 */
export function RevisionHistory({ casefile }: { casefile: CasefileViewModel }) {
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [recover, setRecover] = useState<CasefileRevisionViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isAdmin = casefile.access.kind === "admin_oversight";
  // "Diff vs active" must compare against the LIVE ledger-active revision,
  // not the viewed one: on a ?revision=<archived id> deep link, the read
  // model swaps `casefile.revision` to the viewed snapshot, so use
  // `activeRevisionId` (the live recording.currentRevisionId) and look up its
  // segments in the lineage list (all rows carry segment bodies).
  const activeSegments =
    casefile.revisions.find((revision) => revision.id === casefile.activeRevisionId)?.segments ??
    [];

  function runRecover(source: CasefileRevisionViewModel) {
    setError(null);
    startTransition(async () => {
      const result = await recoverRevisionAction({
        recordingId: casefile.recordingId,
        sourceRevisionId: source.id,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setRecover(null);
      // Navigate OUTSIDE the transition: router.push/refresh inside this
      // async scope races an RSC refresh of the current page - the casefile
      // props change identity under the transition and the push can wedge
      // (same failure class the danger-zone callout names). A hard
      // navigation unloads the page outright - no race.
      window.location.assign(
        appendQueryMessages(result.data.href, { notice: result.notice }),
      );
    });
  }

  return (
    <>
      <ul className="governance-panel__items revision-history">
        {casefile.revisions.map((revision) => {
          const isActive = revision.id === casefile.activeRevisionId;
          const isViewed = revision.id === casefile.revision?.id;
          const diffRows =
            diffFor === revision.id && revision.segments
              ? diffSegments(activeSegments, revision.segments)
              : null;
          return (
            <li className="revision-history__row" key={revision.id}>
              <div className="revision-history__head">
                <strong>v{revision.version}</strong>
                <span>{revision.stateLabel}</span>
                {isActive ? (
                  <span className="status-badge" data-tone="success">
                    Active
                  </span>
                ) : null}
                {isViewed && !isActive ? (
                  <span className="status-badge">Currently viewed</span>
                ) : null}
                <span className="revision-history__date">{revision.createdAtLabel}</span>
              </div>
              <p className="revision-history__summary">{revision.summary}</p>
              <div className="button-row revision-history__actions">
                <Link
                  className="button button-quiet"
                  href={buildRecordingHref(casefile.recordingId, revision.id)}
                >
                  {isActive ? "View (active)" : "View snapshot"}
                </Link>
                {revision.segments && revision.segments.length > 0 ? (
                  <button
                    className="button button-quiet"
                    data-testid={`diff-toggle-v${revision.version}`}
                    onClick={() =>
                      setDiffFor((current) => (current === revision.id ? null : revision.id))
                    }
                    type="button"
                  >
                    {diffFor === revision.id ? "Hide diff" : "Diff vs active"}
                  </button>
                ) : null}
                {isAdmin && !isActive ? (
                  <button
                    className="button button-primary"
                    data-testid={`recover-v${revision.version}`}
                    onClick={() => { setError(null); setRecover(revision); }}
                    type="button"
                  >
                    Recover
                  </button>
                ) : null}
              </div>
              {diffRows ? (
                <ol aria-label={`Diff of v${revision.version} against the active revision`} className="revision-history__diff">
                  {diffRows.map((row) => (
                    <li className="revision-history__diff-row" data-marker={row.marker} key={row.index}>
                      <span className="revision-history__diff-marker">{MARKER_LABEL[row.marker]}</span>
                      <span className="revision-history__diff-range">
                        Segment {row.index + 1}
                        {row.before
                          ? ` · ${formatSegmentWindow(row.before.startMs, row.before.endMs)}`
                          : ""}
                      </span>
                      {row.marker === "changed" ? (
                        <>
                          <span className="revision-history__diff-before">{row.before?.text}</span>
                          <span className="revision-history__diff-after">{row.after?.text}</span>
                        </>
                      ) : row.marker === "removed" ? (
                        <span className="revision-history__diff-before">{row.before?.text}</span>
                      ) : row.marker === "added" ? (
                        <span className="revision-history__diff-after">{row.after?.text}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <Modal
        onClose={() => {
          if (!pending) {
            setRecover(null);
          }
        }}
        open={recover !== null}
        title="Recover revision"
      >
        {recover ? (
          <div className="stack-tight">
            <p className="body-copy">
              Recover the content of revision v{recover.version} as the casefile's active
              revision: a new draft is created from that snapshot (the lineage itself is never
              rewritten). The summary keeps the recovery's provenance, and the audit event records
              the actor and the recovered-from version.
            </p>
            <div className="button-row modal-actions-row">
              <button
                className="button button-secondary"
                disabled={pending}
                onClick={() => setRecover(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={pending}
                onClick={() => runRecover(recover)}
                type="button"
              >
                {pending ? "Recovering..." : `Recover v${recover.version} as active draft`}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
