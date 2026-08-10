// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateActionBar } from "./state-action-bar";

describe("StateActionBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("enables save only while dirty and submit only when allowed", () => {
    const { rerender } = render(
      <StateActionBar
        assignmentLabel="Assigned reviewer"
        canApprove={false}
        canExport={false}
        canReopen={false}
        canRequestChanges={false}
        canSave
        canSubmit
        canWithdraw={false}
        dirty={false}
        onApprove={vi.fn()}
        onExport={vi.fn()}
        onReopen={vi.fn()}
        onRequestChanges={vi.fn()}
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        onWithdraw={vi.fn()}
        phoneSafetyMode={false}
        saving={false}
        stageLabel="Draft review"
      />,
    );

    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeEnabled();

    rerender(
      <StateActionBar
        assignmentLabel="Assigned reviewer"
        canApprove={false}
        canExport={false}
        canReopen={false}
        canRequestChanges={false}
        canSave
        canSubmit={false}
        canWithdraw={false}
        dirty
        onApprove={vi.fn()}
        onExport={vi.fn()}
        onReopen={vi.fn()}
        onRequestChanges={vi.fn()}
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        onWithdraw={vi.fn()}
        phoneSafetyMode={false}
        saving={false}
        stageLabel="Draft review"
      />,
    );

    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
  });

  it("omits mutation buttons in phone safety mode", () => {
    render(
      <StateActionBar
        assignmentLabel="Assigned reviewer"
        canApprove={false}
        canExport={false}
        canReopen={false}
        canRequestChanges={false}
        canSave
        canSubmit
        canWithdraw={false}
        dirty
        onApprove={vi.fn()}
        onExport={vi.fn()}
        onReopen={vi.fn()}
        onRequestChanges={vi.fn()}
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        onWithdraw={vi.fn()}
        phoneSafetyMode
        saving={false}
        stageLabel="Draft review"
      />,
    );

    expect(screen.getByText("Draft review")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
  });

  it("names the withheld governed actions on the phone-safety surface", () => {
    render(
      <StateActionBar
        assignmentLabel="Assigned reviewer"
        canApprove={false}
        canExport={false}
        canReopen={false}
        canRequestChanges={false}
        canSave
        canSubmit
        canWithdraw={false}
        dirty
        onApprove={vi.fn()}
        onExport={vi.fn()}
        onReopen={vi.fn()}
        onRequestChanges={vi.fn()}
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        onWithdraw={vi.fn()}
        phoneSafetyMode
        saving={false}
        stageLabel="Draft review"
      />,
    );

    expect(
      screen.getByText("Review and decisions require a tablet or desktop."),
    ).toHaveClass("casefile-action-bar__phone-note");
  });
});
