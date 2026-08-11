// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdministrationPolicyViewModel } from "@/server/administration/service";
import { PolicySection } from "./policy-section";

const { mockUpdate, mockRefresh } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/server/actions/administration-actions", () => ({
  updateWorkspacePolicyAction: mockUpdate,
}));

const model: AdministrationPolicyViewModel = {
  section: "policy",
  profile: {
    id: "strict",
    label: "Strict",
    description: "Policy facts for governed playback and export.",
  },
  rows: [
    { id: "playback", label: "Playback", uploader: "Denied", reviewer: "Allowed", approver: "Allowed", admin: "Allowed" },
    { id: "raw-download", label: "Raw download", uploader: "Denied", reviewer: "Denied", approver: "Denied", admin: "Allowed" },
    { id: "draft-edit", label: "Edit draft", uploader: "Allowed", reviewer: "Allowed", approver: "Denied", admin: "Denied" },
    { id: "submit", label: "Submit", uploader: "Allowed", reviewer: "Allowed", approver: "Denied", admin: "Denied" },
    { id: "withdraw", label: "Withdraw", uploader: "Denied", reviewer: "Allowed", approver: "Denied", admin: "Denied" },
    { id: "approve", label: "Approve", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Denied" },
    { id: "request-changes", label: "Request changes", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Denied" },
    { id: "reopen", label: "Reopen approved", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Denied" },
    { id: "export", label: "Approved export", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Allowed" },
    { id: "phone-safety", label: "Phone safety", uploader: "Server only", reviewer: "Server only", approver: "Server only", admin: "Server only" },
  ],
};

describe("PolicySection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // The profile IS editable by admins now (demo-governance-bringback); the
  // matrix and the editor coexist - the editor commits via Apply.
  it("renders the complete policy matrix with the profile editor", () => {
    render(<PolicySection model={model} phoneSafetyMode={false} />);

    for (const name of [
      "Playback",
      "Raw download",
      "Edit draft",
      "Submit",
      "Withdraw",
      "Approve",
      "Request changes",
      "Reopen approved",
      "Approved export",
      "Phone safety",
    ]) {
      expect(screen.getByRole("rowheader", { name })).toBeVisible();
    }
    const editor = screen.getByLabelText("Workspace policy profile");
    expect(editor).toBeVisible();
    expect(editor).toHaveValue("strict");
    const apply = screen.getByRole("button", { name: "Apply policy" });
    expect(apply).toBeDisabled(); // nothing to apply until the selection changes
  });

  it("keeps policy facts visible on phone while the editor hides with phone safety", () => {
    render(<PolicySection model={model} phoneSafetyMode={true} />);

    expect(screen.getAllByRole("rowheader", { name: "Phone safety" })[0]).toBeVisible();
    expect(screen.queryByLabelText("Workspace policy profile")).not.toBeInTheDocument();
  });

  it("applies the selection through the server action on click", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValueOnce({
      ok: true,
      data: { profileId: "reviewable-approved-export" },
      notice: "Workspace policy profile updated.",
    });
    render(<PolicySection model={model} phoneSafetyMode={false} />);

    await user.selectOptions(
      screen.getByLabelText("Workspace policy profile"),
      "reviewable-approved-export",
    );
    const apply = screen.getByRole("button", { name: "Apply policy" });
    expect(apply).toBeEnabled();
    await user.click(apply);

    expect(mockUpdate).toHaveBeenCalledWith({ profileId: "reviewable-approved-export" });
    expect(await screen.findByText("Workspace policy profile updated.")).toBeVisible();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("surfaces a server-side rejection inline", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Unknown policy profile.",
    });
    render(<PolicySection model={model} phoneSafetyMode={false} />);

    await user.selectOptions(
      screen.getByLabelText("Workspace policy profile"),
      "reviewable-approved-export",
    );
    await user.click(screen.getByRole("button", { name: "Apply policy" }));

    expect(await screen.findByText("Unknown policy profile.")).toBeVisible();
  });
});
