// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const phoneSafetyModeMock = vi.fn(() => false);

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => phoneSafetyModeMock(),
}));

vi.mock("./accounts-section", () => ({
  AccountsSection: () => <div>Accounts section</div>,
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

    render(<AdministrationShell model={{ section: "accounts" } as never} section="accounts" />);

    expect(
      screen.getByText(
        "Administration changes require a wider screen. Inspect current accounts, assignments, and policy facts here.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Accounts section")).toBeVisible();
  });
});
