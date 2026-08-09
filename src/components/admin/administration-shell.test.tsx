// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { phoneSafetyModeMock, accountsSectionMock, breakGlassPanelMock } =
  vi.hoisted(() => ({
    phoneSafetyModeMock: vi.fn(() => false),
    accountsSectionMock: vi.fn(),
    breakGlassPanelMock: vi.fn(),
  }));

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => phoneSafetyModeMock(),
}));

vi.mock("./accounts-section", () => ({
  AccountsSection: (props: { phoneSafetyMode: boolean }) => {
    accountsSectionMock(props);
    return <div>Accounts section</div>;
  },
}));

vi.mock("./break-glass-panel", () => ({
  BreakGlassPanel: (props: { phoneSafetyMode: boolean }) => {
    breakGlassPanelMock(props);
    return <div>Break-glass panel</div>;
  },
}));

vi.mock("./assignments-section", () => ({
  AssignmentsSection: () => <div>Assignments section</div>,
}));

vi.mock("./policy-section", () => ({
  PolicySection: () => <div>Policy section</div>,
}));

import { AdministrationShell } from "./administration-shell";

describe("AdministrationShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    phoneSafetyModeMock.mockReturnValue(false);
  });

  it("renders only the selected section and marks secondary links with aria-current", () => {
    render(<AdministrationShell model={{ section: "assignments" } as never} section="assignments" />);

    expect(screen.getByRole("link", { name: "Assignments" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Accounts" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Policy" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Assignments section")).toBeVisible();
    expect(screen.queryByText("Accounts section")).not.toBeInTheDocument();
    expect(screen.queryByText("Policy section")).not.toBeInTheDocument();
  });

  it("shows the exact wider-screen phone notice while keeping inspection available", () => {
    phoneSafetyModeMock.mockReturnValue(true);

    render(
      <AdministrationShell
        model={{ section: "accounts", breakGlass: {} } as never}
        section="accounts"
      />,
    );

    expect(
      screen.getByText(
        "Administration changes require a wider screen. Inspect current accounts, assignments, and policy facts here.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Accounts section")).toBeVisible();
    expect(accountsSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ phoneSafetyMode: true }),
    );
    expect(breakGlassPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({ phoneSafetyMode: true }),
    );
  });
});
