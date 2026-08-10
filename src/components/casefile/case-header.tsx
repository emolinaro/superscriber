import Link from "next/link";
import type { CasefileViewModel } from "@/server/casefile/read-model";
import { formatRoleLabel } from "@/lib/format";

/**
 * Casefile UX batch (header gutter + governance placement): one bordered card
 * owns the kicker, title, actions row (Back to Work + Governance link), and
 * the facts grid - every line shares the card's interior gutter. The
 * governance drawer entry lives here; when the drawer is closed the page
 * renders full width (no rail column).
 */
export function CaseHeader({
  casefile,
  governanceOpen = false,
  onToggleGovernance,
}: {
  casefile: CasefileViewModel;
  governanceOpen?: boolean;
  onToggleGovernance?: () => void;
}) {
  const revisionLabel = casefile.revision ? `v${casefile.revision.version}` : "-";

  return (
    <header className="case-header" data-historical={casefile.access.historical || undefined}>
      <div className="case-header__body">
        <div className="case-header__row">
          <div className="case-header__copy-text">
            <p className="eyebrow">Casefile</p>
            <h1 className="section-title case-header__title">{casefile.title}</h1>
          </div>
          {/* Explicit way back to the listing - never a dead end. */}
          <nav aria-label="Casefile" className="case-header__actions">
            <Link className="button button-quiet case-header__back" href="/workspace">
              Back to Work
            </Link>
            {onToggleGovernance ? (
              <button
                aria-expanded={governanceOpen}
                className="case-header__governance"
                onClick={onToggleGovernance}
                type="button"
              >
                Governance&nbsp;&gt;
              </button>
            ) : null}
          </nav>
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
      </div>
    </header>
  );
}
