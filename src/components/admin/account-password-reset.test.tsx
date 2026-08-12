// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPasswordResetModal } from "@/components/admin/account-password-reset";
import { hasSelfResetHold } from "@/lib/self-reset-hold";
import type { AdminPasswordResetActionResult } from "@/server/actions/administration-actions";

const ACCOUNT = { id: "user-1", displayName: "Reviewer One" };
const SELF_RESET_HANDOFF_SUCCESS = {
  ok: true,
  notice: "Reviewer One's password reset was issued.",
  data: {
    targetDisplayName: "Reviewer One",
    resetUrl: "https://app.test/reset/tok",
    expiresAt: "2026-08-10T13:00:00.000Z",
    actorMustRelogin: true,
  },
} satisfies AdminPasswordResetActionResult;
const ACTION_FAILURE_CASES: Array<{
  label: string;
  action: () => Promise<AdminPasswordResetActionResult>;
}> = [
  {
    label: "returns an error",
    action: () =>
      Promise.resolve({
        ok: false,
        code: "INTERNAL_ERROR",
        message: "The password reset could not be completed.",
      }),
  },
  {
    label: "rejects",
    action: () => Promise.reject(new Error("network unavailable")),
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  it("forces handoff delivery when resetting the current account", async () => {
    const action = vi.fn(async () => SELF_RESET_HANDOFF_SUCCESS);
    renderModal({ action, currentUserId: "user-1", resetMailConfigured: true });

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /resetting your own account signs you out; copy the link from this dialog/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/email delivery is unavailable for your own account/i),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "Rotating my own password after a device loss.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(action).toHaveBeenCalledWith({
      userId: "user-1",
      reason: "Rotating my own password after a device loss.",
      delivery: "operator_handoff",
    });
  });

  it("blocks short reasons without calling the action", async () => {
    const action = renderModal({ currentUserId: "user-1" });
    await userEvent.type(screen.getByLabelText(/reason/i), "short");
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));
    expect(await screen.findByText(/between 10 and 500 characters/)).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
    expect(hasSelfResetHold()).toBe(false);
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
    const action = vi.fn(async () => SELF_RESET_HANDOFF_SUCCESS);
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

  it.each(["cancel", "Escape", "backdrop"] as const)(
    "releases an in-flight self-reset hold on %s dismissal",
    async (dismissal) => {
      const user = userEvent.setup();
      const pending = deferred<AdminPasswordResetActionResult>();
      const action = vi.fn(() => pending.promise);
      const onClose = vi.fn();
      const view = render(
        <AccountPasswordResetModal
          account={ACCOUNT}
          action={action}
          currentUserId="user-1"
          onClose={onClose}
          onIssued={() => {}}
          resetMailConfigured={false}
        />,
      );
      onClose.mockImplementation(() => view.unmount());

      await user.type(
        screen.getByLabelText(/reason/i),
        "Rotating my own password after a device loss.",
      );
      await user.click(screen.getByRole("button", { name: /issue reset/i }));

      expect(action).toHaveBeenCalledTimes(1);
      expect(hasSelfResetHold()).toBe(true);

      if (dismissal === "cancel") {
        await user.click(screen.getByRole("button", { name: /cancel/i }));
      } else if (dismissal === "Escape") {
        fireEvent.keyDown(document, { key: "Escape" });
      } else {
        const backdrop = document.querySelector<HTMLElement>(".modal-backdrop");
        expect(backdrop).not.toBeNull();
        fireEvent.mouseDown(backdrop!);
      }

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(hasSelfResetHold()).toBe(false);

      await act(async () => {
        pending.resolve(SELF_RESET_HANDOFF_SUCCESS);
        await pending.promise;
      });
      expect(hasSelfResetHold()).toBe(false);
    },
  );

  it.each(ACTION_FAILURE_CASES)(
    "releases the self-reset hold when issuance $label",
    async ({ action }) => {
      renderModal({ action, currentUserId: "user-1" });
      await userEvent.type(
        screen.getByLabelText(/reason/i),
        "Rotating my own password after a device loss.",
      );
      await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(hasSelfResetHold()).toBe(false);
    },
  );

  it("keeps non-self emailed-delivery copy unchanged", async () => {
    const action = vi.fn(async () => ({
      ok: true as const,
      notice: "Reviewer One's password reset was issued and emailed.",
      data: { ...SELF_RESET_HANDOFF_SUCCESS.data, resetUrl: null, actorMustRelogin: false },
    }));
    renderModal({ action, resetMailConfigured: true });
    await userEvent.click(screen.getByLabelText(/email the reset link/i));
    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "User forgot their password at the front desk.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(
      await screen.findByText(
        "The reset link was emailed. It expires at 2026-08-10T13:00:00.000Z.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/closing this dialog signs you out/i)).not.toBeInTheDocument();
  });

  it("holds every valid issuance until the server reports no actor revocation", async () => {
    const pending = deferred<AdminPasswordResetActionResult>();
    renderModal({ action: () => pending.promise });

    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "User forgot their password at the front desk.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(hasSelfResetHold()).toBe(true);

    await act(async () => {
      pending.resolve({
        ok: true,
        notice: "Reviewer One's password reset was issued.",
        data: {
          targetDisplayName: "Reviewer One",
          resetUrl: "https://app.test/reset/tok",
          expiresAt: "2026-08-10T13:00:00.000Z",
          actorMustRelogin: false,
        },
      });
      await pending.promise;
    });

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(hasSelfResetHold()).toBe(false);
  });

  it("keeps the hold when stale UI identity differs from the server actor", async () => {
    const pending = deferred<AdminPasswordResetActionResult>();
    renderModal({ action: () => pending.promise });

    await userEvent.type(
      screen.getByLabelText(/reason/i),
      "Rotating the active administrator password after a device loss.",
    );
    await userEvent.click(screen.getByRole("button", { name: /issue reset/i }));

    expect(hasSelfResetHold()).toBe(true);

    await act(async () => {
      pending.resolve(SELF_RESET_HANDOFF_SUCCESS);
      await pending.promise;
    });

    expect(await screen.findByDisplayValue("https://app.test/reset/tok")).toBeInTheDocument();
    expect(hasSelfResetHold()).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /done/i }));
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
