import type { CasefileViewModel } from "@/server/casefile/read-model";
import { formatRoleLabel } from "@/lib/format";

export function CaseHeader({ casefile }: { casefile: CasefileViewModel }) {
  const revisionLabel = casefile.revision ? `v${casefile.revision.version}` : "-";

  return (
    <header className="case-header" data-historical={casefile.access.historical || undefined}>
      <div className="case-header__copy">
        <p className="eyebrow">Casefile</p>
        <h1 className="section-title case-header__title">{casefile.title}</h1>
      </div>
      <dl className="case-header__facts">
        <div>
          <dt>State</dt>
          <dd id="case-state" tabIndex={-1}>
            {casefile.stageLabel}
          </dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd data-testid="current-revision">{revisionLabel}</dd>
        </div>
        <div>
          <dt>Assignment</dt>
          <dd>{casefile.assignmentLabel}</dd>
        </div>
        {casefile.actionMode ? (
          <div>
            <dt>Effective role</dt>
            <dd>{formatRoleLabel(casefile.actionMode.effectiveRole)}</dd>
          </div>
        ) : null}
        {casefile.historicalLabel ? (
          <div>
            <dt>Snapshot</dt>
            <dd>{casefile.historicalLabel}</dd>
          </div>
        ) : null}
      </dl>
    </header>
  );
}
