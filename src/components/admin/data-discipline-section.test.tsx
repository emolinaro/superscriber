// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataDisciplineSection } from "./data-discipline-section";

const { mockReset, mockRefresh } = vi.hoisted(() => ({
  mockReset: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/server/actions/administration-actions", () => ({
  resetLedgerAction: mockReset,
}));

const counts = {
  auditEvents: 12,
  decisionRows: 3,
  govActionSessions: 1,
  endedAssignments: 4,
  securityEvents: 7,
};

describe("DataDisciplineSection (demo-governance-bringback)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the ledger counts readout", () => {
    render(<DataDisciplineSection counts={counts} phoneSafetyMode={false} />);

    expect(screen.getByText("Audit events")).toBeVisible();
    expect(screen.getByText("Decision rows")).toBeVisible();
    expect(screen.getByText("Governance action sessions")).toBeVisible();
    expect(screen.getByText("Ended assignments")).toBeVisible();
    expect(screen.getByText("Security events")).toBeVisible();
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByText("7")).toBeVisible();
  });

  it("hides the reset control under phone safety", () => {
    render(<DataDisciplineSection counts={counts} phoneSafetyMode />);

    expect(
      screen.queryByRole("button", { name: "Reset the governed ledger..." }),
    ).toBeNull();
  });

  it("double-gates the wipe on the typed phrase and surfaces the result notice", async () => {
    const user = userEvent.setup();
    mockReset.mockResolvedValueOnce({
      ok: true,
      data: { href: "/administration?section=discipline", userId: "user-admin" },
      notice: "Ledger reset complete.",
    });
    render(<DataDisciplineSection counts={counts} phoneSafetyMode={false} />);

    await user.click(screen.getByRole("button", { name: "Reset the governed ledger..." }));

    expect(
      await screen.findByRole("dialog", { name: "Reset the governed ledger?" }),
    ).toBeVisible();

    const confirm = screen.getByRole("button", { name: "Reset the ledger" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Type RESET REQUIRED to confirm"), "reset required");
    expect(confirm).toBeDisabled();

    await user.clear(screen.getByLabelText("Type RESET REQUIRED to confirm"));
    await user.type(screen.getByLabelText("Type RESET REQUIRED to confirm"), "RESET REQUIRED");
    expect(confirm).toBeEnabled();

    await user.click(confirm);

    expect(mockReset).toHaveBeenCalledWith({ expectedPhrase: "RESET REQUIRED" });
    expect(await screen.findByText("Ledger reset complete.")).toBeVisible();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("keeps the dialog open with the server refusal inline", async () => {
    const user = userEvent.setup();
    mockReset.mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Type the phrase RESET REQUIRED to confirm the ledger wipe.",
    });
    render(<DataDisciplineSection counts={counts} phoneSafetyMode={false} />);

    await user.click(screen.getByRole("button", { name: "Reset the governed ledger..." }));
    await user.type(
      await screen.findByLabelText("Type RESET REQUIRED to confirm"),
      "RESET REQUIRED",
    );
    await user.click(screen.getByRole("button", { name: "Reset the ledger" }));

    expect(
      await screen.findByText("Type the phrase RESET REQUIRED to confirm the ledger wipe."),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
