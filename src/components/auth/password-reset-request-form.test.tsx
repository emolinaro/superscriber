// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_RESET_COPY } from "@/lib/password-reset";
import { PasswordResetRequestForm } from "@/components/auth/password-reset-request-form";

afterEach(cleanup);

describe("PasswordResetRequestForm", () => {
  it("shows the anti-enumeration confirmation when the mail seam is configured", async () => {
    const action = vi.fn(async () => ({
      ok: true as const,
      message: PASSWORD_RESET_COPY.REQUEST_CONFIRMATION,
    }));
    render(<PasswordResetRequestForm action={action} />);

    await userEvent.type(screen.getByLabelText(/email/i), "Person@Example.com ");
    await userEvent.click(screen.getByRole("button", { name: /reset password/i }));

    const confirmation = await screen.findByRole("status");
    expect(confirmation).toHaveTextContent(PASSWORD_RESET_COPY.REQUEST_CONFIRMATION);
    expect(action).toHaveBeenCalledWith({ email: "Person@Example.com" });
    // Identical shape: the form is replaced by a status paragraph for everyone.
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it("plainly states nothing was sent when the instance does not send email", async () => {
    const action = vi.fn(async () => ({
      ok: true as const,
      message: PASSWORD_RESET_COPY.REQUEST_CONFIRMATION_NO_MAIL,
    }));
    render(<PasswordResetRequestForm action={action} />);

    await userEvent.type(screen.getByLabelText(/email/i), "Person@Example.com");
    await userEvent.click(screen.getByRole("button", { name: /reset password/i }));

    const confirmation = await screen.findByRole("status");
    expect(confirmation).toHaveTextContent(
      "This instance does not send email. Your administrator can reset your " +
        "password for you from Administration > Accounts.",
    );
    expect(confirmation).not.toHaveTextContent(/password reset has been started/);
    // Identical shape as the configured posture: same status paragraph, form gone.
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
