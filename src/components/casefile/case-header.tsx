import Link from "next/link";
import type { CasefileViewModel } from "@/server/casefile/read-model";
import { formatRoleLabel } from "@/lib/format";

function buildRecordingHref(recordingId: string, revisionId?: string | null) {
  if (!revisionId) {
    return `/recordings/${recordingId}`;
  }

  return `/recordings/${recordingId}?revision=${encodeURIComponent(revisionId)}`;
}

/**
 * Casefile UX batch (header gutter + governance placement): one bordered card
 * owns the kicker, title, actions row (Back to Work + Governance link), and
 * the facts grid - every line shares the card's interior gutter. The
 * governance drawer entry lives here; when the drawer is closed the page
 * renders full width (no rail column).
 */
export function CaseHeader({
  casefile,
  allowRevisionNav = false,
  governanceOpen = false,
  onToggleGovernance,
}: {
  casefile: CasefileViewModel;
  /** Version history (demo-governance-bringback): admin oversight gets a
     revision snapshot navigator next to the Revision fact. */
  allowRevisionNav?: boolean;
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
            <dd data-testid="current-revision">
              {revisionLabel}
              {allowRevisionNav && casefile.revisions.length > 1 ? (
                <span className="case-header__revision-nav" role="group" aria-label="Revision navigation">
                  {" "}(
                  <select
                    aria-label="Choose a revision snapshot"
                    className="case-header__revision-select"
                    onChange={(event) => {
                      const chosen = casefile.revisions.find(
                        (revision) => revision.id === event.currentTarget.value,
                      );
                      if (!chosen) {
                        return;
                      }
                      // Hard navigation (not router.push): a revision snapshot
                      // swap replaces the whole casefile model, and hard nav
                      // also works when the component renders without an
                      // app-router context (shell-level unit tests).
                      window.location.assign(
                        buildRecordingHref(
                          casefile.recordingId,
                          chosen.id === casefile.revision?.id ? undefined : chosen.id,
                        ),
                      );
                    }}
                    value={casefile.revision?.id ?? ""}
                  >
                    {casefile.revisions.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        v{revision.version} · {revision.stateLabel}
                      </option>
                    ))}
                  </select>
                  )
                </span>
              ) : null}
            </dd>
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
