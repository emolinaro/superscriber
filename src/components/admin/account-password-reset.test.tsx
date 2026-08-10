// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPasswordResetModal } from "@/components/admin/account-password-reset";

const ACCOUNT = { id: "user-1", displayName: "Reviewer One" };

function renderModal(overrides: Partial<Parameters<typeof AccountPasswordResetModal>[0]> = {}) {
  const action =
    overrides.action ??
    vi.fn(async () => ({
      ok: true as const,
      notice: "Reviewer One's password reset was issued.",
      data: {
        targetDisplayName: "Reviewer One",
        resetUrl: "https://app.test/reset/tok",
        expiresAt: "2026-08-10T13:00:00.000Z",
        actorMustRelogin: false,
      },
    }));
  render(
    <AccountPasswordResetModal
      account={ACCOUNT}
      currentUserId="admin-1"
      onClose={() => {}}
      onIssued={() => {}}
      resetMailConfigured={false}
      {...{ ...overrides, action }}
    />,
  );
  return action;
}

afterEach(cleanup);

describe("AccountPasswordResetModal", () => {
  it("hides the email delivery choice when mail is unconfigured", () => {
    renderModal();
    expect(screen.getByLabelText(/out-of-band handoff/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email the reset link/i)).not.toBeInTheDocument();
  });

  it("shows the email delivery choice when mail is configured", () => {
    renderModal({ resetMailConfigured: true });
    expect(screen.getByLabelText(/email the reset link/i)).toBeInTheDocument();
  });

  it("blocks short reasons without calling the action", async () => {
    const action = renderModal();
    await userEvent.type(screen.getByLabelText(/reason/i), "short");
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));
    expect(await screen.findByText(/between 10 and 500 characters/)).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("reveals the handoff link exactly once with expiry", async () => {
    renderModal();
    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "User forgot their password at the front desk.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(screen.getByText(/2026-08-10T13:00:00.000Z/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
  });

  it("warns on self-reset", () => {
    renderModal({ currentUserId: "user-1" });
    expect(screen.getByText(/your own password/)).toBeInTheDocument();
  });
});
