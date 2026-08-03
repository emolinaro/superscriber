import type { CasefileConflictSnapshot } from "@/server/casefile/errors";
import { InlineNotice } from "@/components/ui/inline-notice";

type ConflictPanelProps = {
  conflict: CasefileConflictSnapshot;
  latestHref: string;
  onDiscard: () => void;
};

export function ConflictPanel({ conflict, latestHref, onDiscard }: ConflictPanelProps) {
  return (
    <section aria-label="Revision conflict" className="conflict-panel" role="region">
      <InlineNotice tone="warning">This recording changed since you opened it.</InlineNotice>
      <div className="conflict-panel__facts">
        <p>Loaded revision: {conflict.loadedRevisionId ?? "-"}</p>
        <p>Current revision: {conflict.currentRevisionId ?? "-"}</p>
      </div>
      <div className="button-row conflict-panel__actions">
        <a className="button button-secondary" href={latestHref} rel="noreferrer" target="_blank">
          Open latest revision in a new tab
        </a>
        <button
          className="button button-primary"
          onClick={() => {
            if (
              window.confirm(
                "Discard local transcript changes and reload the latest server revision?",
              )
            ) {
              onDiscard();
            }
          }}
          type="button"
        >
          Discard local changes and reload latest
        </button>
      </div>
    </section>
  );
}
