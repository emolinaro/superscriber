"use client";

import type { CasefileViewModel } from "@/server/casefile/read-model";

export type ChangesRequestedNoticeViewModel = {
  note: string;
  versionLabel: string;
  actorDisplay: string;
  createdAtLabel: string;
};

/**
 * changes-note-rendering: when the live revision state is changes_requested,
 * the reviewer must read the approver's note before anything else. This
 * resolves the note from the latest changes-requested decision that applies
 * to the currently viewed LIVE revision (or to the vetoed revision it was
 * derived from, since requestChangesCommand mints a fresh draft on top of
 * the vetoed pending revision).
 *
 * Archived snapshot deep links (?revision=<archived id>) never surface the
 * banner: the note lives with the live ledger head, not with history.
 */
export function deriveChangesRequestedNotice(
  casefile: CasefileViewModel,
): ChangesRequestedNoticeViewModel | null {
  const revision = casefile.revision;
  if (!revision || revision.id !== casefile.activeRevisionId) {
    return null;
  }

  if (casefile.stage !== "changes_requested") {
    return null;
  }

  const candidateIds = [revision.id, revision.basedOnRevisionId].filter(
    (value): value is string => Boolean(value),
  );
  // decisions are newest-first, so find() picks the latest matching incident.
  const decision = casefile.decisions.find(
    (entry) =>
      (entry.state === "changes_requested" || entry.state === "rejected") &&
      candidateIds.includes(entry.revisionId) &&
      Boolean(entry.note?.trim()),
  );

  if (!decision?.note) {
    return null;
  }

  const versionedRevision =
    casefile.revisions.find((entry) => entry.id === decision.revisionId) ??
    (casefile.revision?.id === decision.revisionId ? casefile.revision : null);

  return {
    note: decision.note,
    versionLabel: versionedRevision ? `v${versionedRevision.version}` : "-",
    actorDisplay: decision.actorDisplay,
    createdAtLabel: decision.createdAtLabel,
  };
}

export function ChangesRequestedNotice({ casefile }: { casefile: CasefileViewModel }) {
  const notice = deriveChangesRequestedNotice(casefile);
  if (!notice) {
    return null;
  }

  // Sacred partition rule: the full note renders unclamped and untruncated.
  return (
    <aside aria-label="Changes requested" className="changes-requested-banner" data-tone="warning">
      <h2 className="changes-requested-banner__title">Changes requested</h2>
      <p className="changes-requested-banner__meta">
        {notice.versionLabel}
        {" · "}
        {notice.actorDisplay}
        {" · "}
        {notice.createdAtLabel}
      </p>
      <p className="changes-requested-banner__note">{notice.note}</p>
    </aside>
  );
}
