"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

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
  exportDisabledReason?: string;
  exportLabel?: string;
  saving: boolean;
  phoneSafetyMode: boolean;
  /**
   * Governed destructive action (recording purge), pinned in the bar for
   * admin oversight so it never scrolls away. Rendered last in the buttons
   * row in the loud danger treatment so it never reads as just another
   * state button; like every governed control it is withheld under phone
   * safety mode together with the row.
   */
  dangerAction?: ReactNode;
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
  exportDisabledReason,
  exportLabel,
  saving,
  phoneSafetyMode,
  dangerAction,
  onSave,
  onSubmit,
  onWithdraw,
  onApprove,
  onRequestChanges,
  onReopen,
  onExport,
}: StateActionBarProps) {
  const exportDisabledReasonId = useId();
  const actionBarRef = useRef<HTMLElement | null>(null);
  const hasGovernedActions =
    canSubmit || canWithdraw || canApprove || canRequestChanges || canReopen || canExport;
  // The phone-safety note names every withheld governed surface, including a
  // pinned destructive action when that is the only one on the bar.
  const hasWithheldControls = hasGovernedActions || Boolean(dangerAction);

  useEffect(() => {
    const actionBar = actionBarRef.current;
    if (!actionBar) {
      return;
    }

    const page = actionBar.closest<HTMLElement>(".casefile-page");
    const root = document.documentElement;
    const previousPageClearance =
      page?.style.getPropertyValue("--action-bar-clearance") ?? "";
    const previousRootClearance = root.style.getPropertyValue("--action-bar-clearance");
    const updateClearance = () => {
      const height = Math.ceil(actionBar.getBoundingClientRect().height);
      if (height <= 0) {
        return;
      }
      const value = `${height}px`;
      page?.style.setProperty("--action-bar-clearance", value);
      root.style.setProperty("--action-bar-clearance", value);
    };

    updateClearance();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateClearance);
    observer?.observe(actionBar);

    return () => {
      observer?.disconnect();
      if (page) {
        if (previousPageClearance) {
          page.style.setProperty("--action-bar-clearance", previousPageClearance);
        } else {
          page.style.removeProperty("--action-bar-clearance");
        }
      }
      if (previousRootClearance) {
        root.style.setProperty("--action-bar-clearance", previousRootClearance);
      } else {
        root.style.removeProperty("--action-bar-clearance");
      }
    };
  }, []);

  return (
    <section
      aria-label="Case actions"
      className="casefile-action-bar"
      ref={actionBarRef}
    >
      <div className="casefile-action-bar__meta">
        <strong>{stageLabel}</strong>
        <span>{assignmentLabel}</span>
        {dirty ? <span className="casefile-action-bar__dirty">Unsaved changes</span> : null}
      </div>
      {phoneSafetyMode && hasWithheldControls ? (
        <p className="field-note casefile-action-bar__phone-note">
          Review and decisions require a tablet or desktop.
        </p>
      ) : null}
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
            <button
              aria-describedby={exportDisabledReason ? exportDisabledReasonId : undefined}
              className="button button-secondary"
              disabled={Boolean(exportDisabledReason)}
              onClick={onExport}
              type="button"
            >
              {exportLabel ?? "Export approved transcript"}
            </button>
          ) : null}
          {dangerAction ?? null}
          {!canSave && !hasGovernedActions ? null : null}
        </div>
      ) : null}
      {!phoneSafetyMode && canExport && exportDisabledReason ? (
        <p className="field-note" id={exportDisabledReasonId}>
          {exportDisabledReason}
        </p>
      ) : null}
    </section>
  );
}
