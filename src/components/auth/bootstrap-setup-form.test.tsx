// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapFormState } from "@/lib/auth-forms";
import type { BootstrapReadiness } from "@/server/bootstrap/readiness";
import { BootstrapSetupForm } from "./bootstrap-setup-form";

const { mockRefresh } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

const READY_READINESS: BootstrapReadiness = {
  overall: "ready",
  checks: [
    { id: "database", label: "Database", state: "ready", detail: "Ready." },
    { id: "media_storage", label: "Media storage", state: "ready", detail: "Ready." },
    { id: "upload_storage", label: "Upload storage", state: "ready", detail: "Ready." },
    { id: "auth_secret", label: "Auth secret", state: "ready", detail: "Ready." },
    {
      id: "engine_configuration",
      label: "Engine configuration",
      state: "ready",
      detail: "Ready.",
    },
  ],
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("BootstrapSetupForm", () => {
  beforeEach(() => {
    mockRefresh.mockReset();
  });

  it("focuses the error summary, links to invalid fields, preserves name and email, and clears passwords", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({
      formError: "Review the highlighted fields and try again.",
      fieldErrors: {
        displayName: "Enter the administrator's name.",
        email: "Enter a valid email address.",
        password: "Use at least 10 characters.",
      },
      values: {
        displayName: "Admin Example",
        email: "admin@example.com",
      },
    })) satisfies (state: BootstrapFormState, formData: FormData) => Promise<BootstrapFormState>;

    render(<BootstrapSetupForm action={action} readiness={READY_READINESS} />);

    await user.type(screen.getByLabelText("Administrator name"), "Admin Example");
    await user.type(screen.getByLabelText("Administrator email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "secret value");
    await user.type(screen.getByLabelText("Confirm password"), "secret value");
    await user.click(screen.getByRole("button", { name: "Create admin" }));

    const summary = await screen.findByRole("alert", { name: "There is a problem" });
    await waitFor(() => {
      expect(summary).toHaveFocus();
    });

    await user.click(
      screen.getByRole("link", {
        name: "Administrator email - Enter a valid email address.",
      }),
    );
    expect(screen.getByLabelText("Administrator email")).toHaveFocus();
    expect(screen.getByLabelText("Administrator name")).toHaveValue("Admin Example");
    expect(screen.getByLabelText("Administrator email")).toHaveValue("admin@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm password")).toHaveValue("");
  });

  it("disables setup while readiness is blocked and retries readiness checks", async () => {
    const user = userEvent.setup();

    render(
      <BootstrapSetupForm
        action={vi.fn(async () => ({ values: {} }))}
        readiness={{
          overall: "blocked",
          checks: READY_READINESS.checks.map((check) =>
            check.id === "engine_configuration"
              ? { ...check, state: "blocked", detail: "Fix the engine configuration." }
              : check,
          ),
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Create admin" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry checks" }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("prevents double submit while the action is pending", async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<BootstrapFormState>();
    const action = vi.fn(() => deferred.promise);

    render(<BootstrapSetupForm action={action} readiness={READY_READINESS} />);

    await user.type(screen.getByLabelText("Administrator name"), "Admin Example");
    await user.type(screen.getByLabelText("Administrator email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm password"), "correct horse battery staple");

    const submit = screen.getByRole("button", { name: "Create admin" });
    await user.click(submit);
    await user.click(submit);

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Creating account..." })).toBeDisabled();

    deferred.resolve({ values: {} });
  });

  it("blocks a password confirmation mismatch before submit and announces the copy", async () => {
    const user = userEvent.setup();
    const action: (state: BootstrapFormState, formData: FormData) => Promise<BootstrapFormState> =
      vi.fn(async () => ({ values: {} }));

    render(<BootstrapSetupForm action={action} readiness={READY_READINESS} />);

    await user.type(screen.getByLabelText("Administrator name"), "Admin Example");
    await user.type(screen.getByLabelText("Administrator email"), "admin@example.com");
    const passwordInput = screen.getByLabelText("Password");
    const confirmInput = screen.getByLabelText("Confirm password");
    await user.type(passwordInput, "correct horse battery staple");
    await user.type(confirmInput, "different horse battery staple");

    expect(screen.getByText("Passwords must match.")).toHaveAttribute("role", "alert");
    expect(confirmInput).toHaveAttribute("aria-invalid", "true");
    expect(confirmInput).toHaveAttribute("aria-describedby", "confirmPassword-error");
    expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput.getAttribute("aria-describedby")).toContain("confirmPassword-error");
    const submit = screen.getByRole("button", { name: "Create admin" });
    expect(submit).toBeDisabled();

    // A real Enter key from another single-line field must still surface the
    // submit-attempt summary and move focus to the confirmation field even
    // though the submit button is disabled during a live mismatch.
    await user.type(screen.getByLabelText("Administrator email"), "{Enter}");
    const summary = screen.getByRole("alert", { name: "There is a problem" });
    expect(
      within(summary).getByText("Confirm password - Passwords must match."),
    ).toBeVisible();
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

    await user.click(submit);
    expect(action).toHaveBeenCalledTimes(1);
    const formData = vi.mocked(action).mock.calls[0]?.[1];
    expect(formData?.get("confirmPassword")).toBe("correct horse battery staple");
  });

  it("blocks a blank password confirmation through the field and error summary", async () => {
    const user = userEvent.setup();
    const action: (state: BootstrapFormState, formData: FormData) => Promise<BootstrapFormState> =
      vi.fn(async () => ({ values: {} }));

    render(<BootstrapSetupForm action={action} readiness={READY_READINESS} />);

    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    const confirmInput = screen.getByLabelText("Confirm password");
    await user.click(screen.getByRole("button", { name: "Create admin" }));

    expect(action).not.toHaveBeenCalled();
    expect(confirmInput).toHaveAttribute("aria-invalid", "true");
    expect(confirmInput).toHaveAttribute("aria-describedby", "confirmPassword-error");
    expect(screen.getByText("Confirm the password.")).toBeVisible();
    const summary = screen.getByRole("alert", { name: "There is a problem" });
    expect(
      within(summary).getByText("Confirm password - Confirm the password."),
    ).toBeVisible();
    await waitFor(() => {
      expect(confirmInput).toHaveFocus();
    });
  });
});
