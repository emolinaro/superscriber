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
        canSave
        canSubmit
        dirty={false}
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        phoneSafetyMode={false}
        saving={false}
        stageLabel="Draft review"
        submitting={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeEnabled();

    rerender(
      <StateActionBar
        assignmentLabel="Assigned reviewer"
        canSave
        canSubmit={false}
        dirty
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        phoneSafetyMode={false}
        saving={false}
        stageLabel="Draft review"
        submitting={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeDisabled();
  });

  it("omits mutation buttons in phone safety mode", () => {
    render(
      <StateActionBar
        assignmentLabel="Assigned reviewer"
        canSave
        canSubmit
        dirty
        onSave={vi.fn()}
        onSubmit={vi.fn()}
        phoneSafetyMode
        saving={false}
        stageLabel="Draft review"
        submitting={false}
      />,
    );

    expect(screen.getByText("Draft review")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
  });
});
