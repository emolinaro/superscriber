// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_RESET_COPY } from "@/lib/password-reset";
import { PasswordResetRequestForm } from "@/components/auth/password-reset-request-form";

afterEach(cleanup);

describe("PasswordResetRequestForm", () => {
  it("always shows the identical confirmation after submit", async () => {
    const action = vi.fn(async () => ({
      ok: true as const,
      message: PASSWORD_RESET_COPY.REQUEST_CONFIRMATION,
    }));
    render(<PasswordResetRequestForm action={action} />);

    await userEvent.type(screen.getByLabelText(/email/i), "Person@Example.com ");
    await userEvent.click(screen.getByRole("button", { name: /reset password/i }));

    expect(
      await screen.findByText(/If an account matches that email/),
    ).toBeInTheDocument();
    expect(action).toHaveBeenCalledWith({ email: "Person@Example.com" });
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it("shows an email field error without calling the action", async () => {
    const action = vi.fn();
    render(<PasswordResetRequestForm action={action as never} />);

    await userEvent.type(screen.getByLabelText(/email/i), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /reset password/i }));

    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
