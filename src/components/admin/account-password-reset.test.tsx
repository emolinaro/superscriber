// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPasswordResetModal } from "@/components/admin/account-password-reset";
import { hasSelfResetHold } from "@/lib/self-reset-hold";

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

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("AccountPasswordResetModal", () => {
  it("replaces the delivery radio with plain handoff copy when mail is unconfigured", () => {
    renderModal();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(
      screen.getByText(/email delivery is not configured on this appliance/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/copy it and hand it over directly/i)).toBeInTheDocument();
  });

  it("shows both delivery choices when mail is configured", () => {
    renderModal({ resetMailConfigured: true });
    expect(screen.getByLabelText(/out-of-band handoff/i)).toBeInTheDocument();
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

  it("warns on self-reset that issuance signs the admin out everywhere", () => {
    renderModal({ currentUserId: "user-1" });
    expect(screen.getByText(/signs YOU out everywhere/i)).toBeInTheDocument();
    expect(screen.getByText(/including this session/i)).toBeInTheDocument();
    expect(screen.getByText(/moment you close the result dialog/i)).toBeInTheDocument();
  });

  it("does not show the self-reset disclosure for other accounts", () => {
    renderModal();
    expect(screen.queryByText(/signs YOU out everywhere/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/copy this link now/i)).not.toBeInTheDocument();
  });

  it("notifies issuance immediately for non-self resets", async () => {
    const onIssued = vi.fn();
    renderModal({ onIssued });
    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "User forgot their password at the front desk.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(onIssued).toHaveBeenCalledTimes(1);
  });

  it("keeps the one-time reveal mounted on self-reset until dismissed", async () => {
    const onIssued = vi.fn();
    const action = vi.fn(async () => ({
      ok: true as const,
      notice: "Reviewer One's password reset was issued.",
      data: {
        targetDisplayName: "Reviewer One",
        resetUrl: "https://app.test/reset/tok",
        expiresAt: "2026-08-10T13:00:00.000Z",
        actorMustRelogin: true,
      },
    }));
    renderModal({ action, currentUserId: "user-1", onIssued });
    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "Rotating my own password after a device loss.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(onIssued).not.toHaveBeenCalled();
    expect(hasSelfResetHold()).toBe(true);

    const disclosure = screen.getByText(/copy this link now/i);
    expect(disclosure).toBeInTheDocument();
    expect(screen.getByText(/closing this dialog signs you out/i)).toBeInTheDocument();
    expect(screen.getByText(/private window/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(onIssued).toHaveBeenCalledTimes(1);
    expect(hasSelfResetHold()).toBe(false);
  });

  it("does not hold the session guard when issuance does not revoke our session", async () => {
    renderModal({ currentUserId: "user-1" });
    expect(hasSelfResetHold()).toBe(false);

    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "Rotating my own password after a device loss.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(hasSelfResetHold()).toBe(false);
  });

  it("omits the sign-out disclosure on the issued stage for non-self resets", async () => {
    renderModal();
    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "User forgot their password at the front desk.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(screen.queryByText(/copy this link now/i)).not.toBeInTheDocument();
  });
});
