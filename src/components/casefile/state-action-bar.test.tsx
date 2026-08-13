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

  it("renders the pinned governed destructive action last in the buttons row", () => {
    render(
      <StateActionBar
        assignmentLabel="Admin oversight"
        canApprove={false}
        canExport
        canReopen={false}
        canRequestChanges={false}
        canSave={false}
        canSubmit={false}
        canWithdraw={false}
        dangerAction={<button type="button">Delete recording permanently...</button>}
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
        stageLabel="Approved"
      />,
    );

    const exportButton = screen.getByRole("button", { name: "Export approved transcript" });
    const deleteButton = screen.getByRole("button", {
      name: "Delete recording permanently...",
    });
    expect(deleteButton).toBeVisible();
    // The destructive command trails the workflow actions inside the pinned
    // bar (DOM order), so it reads as the dangerous outlier, not a peer of
    // Submit/Approve.
    expect(
      exportButton.compareDocumentPosition(deleteButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("withholds the pinned destructive action under phone safety and still names it", () => {
    render(
      <StateActionBar
        assignmentLabel="Admin oversight"
        canApprove={false}
        canExport={false}
        canReopen={false}
        canRequestChanges={false}
        canSave={false}
        canSubmit={false}
        canWithdraw={false}
        dangerAction={<button type="button">Delete recording permanently...</button>}
        dirty={false}
        onApprove={vi.fn()}
        onExport={vi.fn()}
        onReopen={vi.fn()}
        onRequestChanges={vi.fn()}
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        onWithdraw={vi.fn()}
        phoneSafetyMode
        saving={false}
        stageLabel="Approved"
      />,
    );

    // Even when the destructive action is the ONLY control the bar would
    // show, phone safety withholds it like the sibling governed dialogs and
    // the note explains why.
    expect(
      screen.queryByRole("button", { name: "Delete recording permanently..." }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Review and decisions require a tablet or desktop."),
    ).toBeVisible();
  });
});
