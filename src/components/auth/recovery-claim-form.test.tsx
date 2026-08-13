// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecoveryClaimFormState } from "@/lib/auth-forms";
import { RecoveryClaimForm } from "./recovery-claim-form";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function renderForm(action?: RecoveryClaimFormProps["action"]) {
  return render(
    <RecoveryClaimForm
      action={action ?? vi.fn(async () => ({ values: {} }))}
      claimTokenPath="/var/lib/superscriber/admin-claim.token"
    />,
  );
}

type RecoveryClaimFormProps = Parameters<typeof RecoveryClaimForm>[0];

describe("RecoveryClaimForm", () => {
  it("shows the operator-only claim contract: token field and on-host proof location", () => {
    renderForm();

    expect(
      screen.getByLabelText("Operator claim token"),
    ).toBeInTheDocument();
    expect(screen.getByText("/var/lib/superscriber/admin-claim.token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim administrator" })).toBeEnabled();
    // The claim form explicitly warns about the takeover boundary.
    expect(screen.getByText(/network attacker/i)).toBeInTheDocument();
  });

  it("maps claim-token refusals onto the token field, clears passwords, keeps the token editable", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({
      formError:
        "The administrator claim was not accepted. Check the operator claim token and try again.",
      fieldErrors: {
        claimToken: "The claim token did not match the proof on the appliance host.",
      },
      values: {
        displayName: "Recovery Admin",
        email: "recovery@example.com",
      },
    })) satisfies RecoveryClaimFormProps["action"];

    renderForm(action);

    await user.type(screen.getByLabelText("Administrator name"), "Recovery Admin");
    await user.type(screen.getByLabelText("Administrator email"), "recovery@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Operator claim token"), "deadbeef".repeat(8));
    await user.click(screen.getByRole("button", { name: "Claim administrator" }));

    const summary = await screen.findByRole("alert", { name: "There is a problem" });
    await waitFor(() => {
      expect(summary).toHaveFocus();
    });
    expect(
      screen.getByText("The claim token did not match the proof on the appliance host."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm password")).toHaveValue("");
    expect(screen.getByLabelText("Administrator email")).toHaveValue("recovery@example.com");
  });

  it("renders a standalone refusal alert when the claim fails without field errors", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({
      formError: "Too many administrator claim attempts. Wait a few minutes and try again.",
      values: {},
    })) satisfies RecoveryClaimFormProps["action"];

    renderForm(action);

    await user.type(screen.getByLabelText("Administrator name"), "Recovery Admin");
    await user.type(screen.getByLabelText("Administrator email"), "recovery@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Operator claim token"), "deadbeef".repeat(8));
    await user.click(screen.getByRole("button", { name: "Claim administrator" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Too many administrator claim attempts");
    });
  });

  it("prevents double submit while the claim is pending", async () => {
    const user = userEvent.setup();
    let resolveAction!: (state: RecoveryClaimFormState) => void;
    const action = vi.fn(
      () =>
        new Promise<RecoveryClaimFormState>((resolve) => {
          resolveAction = resolve;
        }),
    );

    renderForm(action);

    await user.type(screen.getByLabelText("Administrator name"), "Recovery Admin");
    await user.type(screen.getByLabelText("Administrator email"), "recovery@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Operator claim token"), "deadbeef".repeat(8));

    const submit = screen.getByRole("button", { name: "Claim administrator" });
    await user.click(submit);
    await user.click(submit);

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creating account..." })).toBeDisabled();

    resolveAction({ values: {} });
  });

  it("blocks a password confirmation mismatch before submit and announces the copy", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({ values: {} }));

    renderForm(action);

    const passwordInput = screen.getByLabelText("Password");
    const confirmInput = screen.getByLabelText("Confirm password");
    await user.type(passwordInput, "correct horse battery staple");
    await user.type(confirmInput, "different horse battery staple");

    expect(screen.getByText("Passwords must match.")).toHaveAttribute("role", "alert");
    expect(confirmInput).toHaveAttribute("aria-invalid", "true");
    expect(confirmInput).toHaveAttribute("aria-describedby", "confirmPassword-error");
    expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput.getAttribute("aria-describedby")).toContain("confirmPassword-error");
    const submit = screen.getByRole("button", { name: "Claim administrator" });
    expect(submit).toBeDisabled();

    const form = confirmInput.closest("form");
    if (!form) {
      throw new Error("Expected the claim form to render.");
    }
    fireEvent.submit(form);
    await waitFor(() => {
      expect(confirmInput).toHaveFocus();
    });
    expect(action).not.toHaveBeenCalled();

    await user.clear(confirmInput);
    await user.type(confirmInput, "correct horse battery staple");
    expect(screen.queryByText("Passwords must match.")).not.toBeInTheDocument();
    expect(confirmInput).not.toHaveAttribute("aria-invalid");
    expect(passwordInput).not.toHaveAttribute("aria-invalid");
    expect(submit).toBeEnabled();
  });
});
