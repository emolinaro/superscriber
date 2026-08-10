// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_RESET_COPY } from "@/lib/password-reset";
import { PasswordResetCompletionForm } from "@/components/auth/password-reset-completion-form";

afterEach(cleanup);

describe("PasswordResetCompletionForm", () => {
  it("submits the token with both passwords and shows success with a sign-in link", async () => {
    const action = vi.fn(async () => ({
      ok: true as const,
      message: PASSWORD_RESET_COPY.REDEEM_SUCCESS,
    }));
    render(<PasswordResetCompletionForm token="tok-123" action={action} />);

    await userEvent.type(screen.getByLabelText(/^new password$/i), "NewPassword!234");
    await userEvent.type(screen.getByLabelText(/confirm new password/i), "NewPassword!234");
    await userEvent.click(screen.getByRole("button", { name: /set new password/i }));

    expect(await screen.findByText(PASSWORD_RESET_COPY.REDEEM_SUCCESS)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
    expect(action).toHaveBeenCalledWith({
      token: "tok-123",
      password: "NewPassword!234",
      confirmPassword: "NewPassword!234",
    });
  });

  it("blocks mismatched passwords without calling the action", async () => {
    const action = vi.fn();
    render(<PasswordResetCompletionForm token="tok-123" action={action as never} />);

    await userEvent.type(screen.getByLabelText(/^new password$/i), "NewPassword!234");
    await userEvent.type(screen.getByLabelText(/confirm new password/i), "Different!234");
    await userEvent.click(screen.getByRole("button", { name: /set new password/i }));

    expect(await screen.findByText(/must match/i)).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("shows the generic failure copy from the server", async () => {
    const action = vi.fn(async () => ({
      ok: false as const,
      message: PASSWORD_RESET_COPY.REDEEM_FAILURE,
    }));
    render(<PasswordResetCompletionForm token="tok-123" action={action} />);

    await userEvent.type(screen.getByLabelText(/^new password$/i), "NewPassword!234");
    await userEvent.type(screen.getByLabelText(/confirm new password/i), "NewPassword!234");
    await userEvent.click(screen.getByRole("button", { name: /set new password/i }));

    expect(await screen.findByText(PASSWORD_RESET_COPY.REDEEM_FAILURE)).toBeInTheDocument();
  });
});
