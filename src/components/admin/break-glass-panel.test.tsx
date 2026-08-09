// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BreakGlassPanelModel } from "@/server/administration/service";
import { BreakGlassPanel } from "./break-glass-panel";

vi.mock("@/server/actions/break-glass-actions", () => ({
  beginBreakGlassKeyEnrollmentAction: vi.fn(),
  completeBreakGlassKeyEnrollmentAction: vi.fn(),
  designateBreakGlassAdminAction: vi.fn(),
  rotateBreakGlassRecoveryCodesAction: vi.fn(),
}));

function createModel(overrides: Partial<BreakGlassPanelModel> = {}): BreakGlassPanelModel {
  return {
    designation: {
      userId: "custodian-1",
      displayName: "Custodian One",
      updatedAt: "2026-08-01T12:00:00.000Z",
    },
    viewerIsCustodian: false,
    enrolledKeyCount: 2,
    recoveryCodeCount: 10,
    adminCandidates: [],
    ...overrides,
  };
}

describe("BreakGlassPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides custody controls for non-custodian admins while keeping designation facts visible", () => {
    render(<BreakGlassPanel model={createModel()} phoneSafetyMode={false} />);

    expect(screen.getByTestId("break-glass-status")).toHaveTextContent("Custodian One");
    expect(screen.getByTestId("break-glass-status")).toHaveTextContent(
      "Security keys enrolled: 2",
    );
    expect(
      screen.queryByRole("button", { name: "Enroll security key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Issue new recovery codes" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Security key label")).not.toBeInTheDocument();
    expect(screen.getByTestId("break-glass-custody-note")).toHaveTextContent(
      "Custody operations require the designated custodian's own session.",
    );
  });

  it("renders custody controls for the designated custodian", () => {
    render(
      <BreakGlassPanel
        model={createModel({ viewerIsCustodian: true })}
        phoneSafetyMode={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Enroll security key" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Issue new recovery codes" })).toBeVisible();
    expect(screen.getByLabelText("Security key label")).toBeVisible();
    expect(screen.queryByTestId("break-glass-custody-note")).not.toBeInTheDocument();
  });

  it("renders the designation form when no custodian is designated", () => {
    render(
      <BreakGlassPanel
        phoneSafetyMode={false}
        model={createModel({
          designation: null,
          viewerIsCustodian: false,
          enrolledKeyCount: 0,
          recoveryCodeCount: 0,
          adminCandidates: [{ id: "admin-1", displayName: "Admin One" }],
        })}
      />,
    );

    expect(screen.getByTestId("break-glass-status")).toHaveTextContent(
      "No break-glass administrator is designated",
    );
    expect(screen.getByRole("button", { name: "Designate custodian" })).toBeVisible();
    expect(screen.queryByTestId("break-glass-custody-note")).not.toBeInTheDocument();
  });

  it("keeps emergency facts but omits every mutation in phone safety mode", () => {
    const { rerender } = render(
      <BreakGlassPanel
        model={createModel({ viewerIsCustodian: true })}
        phoneSafetyMode
      />,
    );

    expect(screen.getByTestId("break-glass-status")).toHaveTextContent("Custodian One");
    expect(screen.queryByLabelText("Security key label")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enroll security key" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Issue new recovery codes" }),
    ).not.toBeInTheDocument();

    rerender(
      <BreakGlassPanel
        model={createModel({
          designation: null,
          viewerIsCustodian: false,
          enrolledKeyCount: 0,
          recoveryCodeCount: 0,
          adminCandidates: [{ id: "admin-1", displayName: "Admin One" }],
        })}
        phoneSafetyMode
      />,
    );
    expect(screen.getByTestId("break-glass-status")).toHaveTextContent(
      "No break-glass administrator is designated",
    );
    expect(screen.queryByLabelText("Designate active admin")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Change reason")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Designate custodian" }),
    ).not.toBeInTheDocument();
  });
});
