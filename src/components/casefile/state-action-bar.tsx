type StateActionBarProps = {
  assignmentLabel: string;
  stageLabel: string;
  dirty: boolean;
  canSave: boolean;
  canSubmit: boolean;
  saving: boolean;
  submitting: boolean;
  phoneSafetyMode: boolean;
  onSave: () => void;
  onSubmit: () => void;
};

export function StateActionBar({
  assignmentLabel,
  stageLabel,
  dirty,
  canSave,
  canSubmit,
  saving,
  submitting,
  phoneSafetyMode,
  onSave,
  onSubmit,
}: StateActionBarProps) {
  return (
    <section className="casefile-action-bar" aria-label="Case actions">
      <div className="casefile-action-bar__meta">
        <strong>{stageLabel}</strong>
        <span>{assignmentLabel}</span>
        {dirty ? <span className="casefile-action-bar__dirty">Unsaved changes</span> : null}
      </div>
      {!phoneSafetyMode ? (
        <div className="button-row casefile-action-bar__buttons">
          <button
            className="button button-secondary"
            disabled={!dirty || !canSave || saving || submitting}
            onClick={onSave}
            type="button"
          >
            {saving ? "Saving..." : "Save draft"}
          </button>
          <button
            className="button button-primary"
            disabled={!canSubmit || saving || submitting}
            onClick={onSubmit}
            type="button"
          >
            {submitting ? "Submitting..." : "Submit for approval"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
