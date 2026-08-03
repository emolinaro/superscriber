type StateActionBarProps = {
  assignmentLabel: string;
  stageLabel: string;
  dirty: boolean;
  canSave: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canReopen: boolean;
  canExport: boolean;
  saving: boolean;
  phoneSafetyMode: boolean;
  onSave: () => void;
  onSubmit: () => void;
  onWithdraw: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onReopen: () => void;
  onExport: () => void;
};

export function StateActionBar({
  assignmentLabel,
  stageLabel,
  dirty,
  canSave,
  canSubmit,
  canWithdraw,
  canApprove,
  canRequestChanges,
  canReopen,
  canExport,
  saving,
  phoneSafetyMode,
  onSave,
  onSubmit,
  onWithdraw,
  onApprove,
  onRequestChanges,
  onReopen,
  onExport,
}: StateActionBarProps) {
  const hasGovernedActions =
    canSubmit || canWithdraw || canApprove || canRequestChanges || canReopen || canExport;

  return (
    <section className="casefile-action-bar" aria-label="Case actions">
      <div className="casefile-action-bar__meta">
        <strong>{stageLabel}</strong>
        <span>{assignmentLabel}</span>
        {dirty ? <span className="casefile-action-bar__dirty">Unsaved changes</span> : null}
      </div>
      {!phoneSafetyMode ? (
        <div className="button-row casefile-action-bar__buttons">
          {canSave ? (
            <button
              className="button button-secondary"
              disabled={!dirty || saving}
              onClick={onSave}
              type="button"
            >
              {saving ? "Saving..." : "Save draft"}
            </button>
          ) : null}
          {canSubmit ? (
            <button className="button button-primary" onClick={onSubmit} type="button">
              Submit for approval
            </button>
          ) : null}
          {canWithdraw ? (
            <button className="button button-secondary" onClick={onWithdraw} type="button">
              Withdraw revision
            </button>
          ) : null}
          {canRequestChanges ? (
            <button className="button button-secondary" onClick={onRequestChanges} type="button">
              Request changes
            </button>
          ) : null}
          {canApprove ? (
            <button className="button button-primary" onClick={onApprove} type="button">
              Approve and complete work
            </button>
          ) : null}
          {canReopen ? (
            <button className="button button-secondary" onClick={onReopen} type="button">
              Reopen as draft
            </button>
          ) : null}
          {canExport ? (
            <button className="button button-secondary" onClick={onExport} type="button">
              Export approved transcript
            </button>
          ) : null}
          {!canSave && !hasGovernedActions ? null : null}
        </div>
      ) : null}
    </section>
  );
}
