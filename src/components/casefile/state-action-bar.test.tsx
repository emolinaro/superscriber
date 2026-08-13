// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateActionBar } from "./state-action-bar";

describe("StateActionBar", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--action-bar-clearance");
  });

  it("publishes the rendered action bar height as bottom clearance", () => {
    let resizeCallback: ResizeObserverCallback = () => undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        observe = observe;
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    const { container } = render(
      <div className="casefile-page">
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
        />
      </div>,
    );

    const page = container.querySelector<HTMLElement>(".casefile-page")!;
    const actionBar = container.querySelector<HTMLElement>(".casefile-action-bar")!;
    actionBar.getBoundingClientRect = () => ({ height: 96 } as DOMRect);
    resizeCallback([], {} as ResizeObserver);

    expect(observe).toHaveBeenCalledWith(actionBar);
    expect(page.style.getPropertyValue("--action-bar-clearance")).toBe("96px");
    expect(
      document.documentElement.style.getPropertyValue("--action-bar-clearance"),
    ).toBe("96px");
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
