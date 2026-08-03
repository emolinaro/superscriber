// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";

const {
  mockPush,
  mockRefresh,
  mockSignIn,
  mockConsumeBootstrapEmail,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockSignIn: vi.fn(),
  mockConsumeBootstrapEmail: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

vi.mock("next-auth/react", () => ({
  signIn: mockSignIn,
}));

vi.mock("@/server/actions/auth-actions", async () => {
  const actual = await vi.importActual<typeof import("@/server/actions/auth-actions")>(
    "@/server/actions/auth-actions",
  );

  return {
    ...actual,
    consumeBootstrapEmailAction: mockConsumeBootstrapEmail,
  };
});

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

describe("LoginForm", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockRefresh.mockReset();
    mockSignIn.mockReset();
    mockConsumeBootstrapEmail.mockReset();
    mockConsumeBootstrapEmail.mockResolvedValue(undefined);
  });

  it("prefills email once, sanitizes returnTo, and focuses Password on wrong credentials", async () => {
    const user = userEvent.setup();
    mockSignIn.mockResolvedValue({ error: "CredentialsSignin" });

    render(<LoginForm initialEmail="admin@example.com" returnTo="https://evil.test" />);

    expect(screen.getByLabelText("Email")).toHaveValue("admin@example.com");
    await user.type(screen.getByLabelText("Password"), "bad password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(mockConsumeBootstrapEmail).toHaveBeenCalledTimes(1);
    expect(mockSignIn).toHaveBeenCalledWith("credentials", {
      email: "admin@example.com",
      password: "bad password",
      redirect: false,
      callbackUrl: "/workspace",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password was not accepted. Check both fields and try again.",
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveFocus();
  });

  it("treats a CredentialsSignin error in the returned url as wrong credentials", async () => {
    const user = userEvent.setup();
    mockSignIn.mockResolvedValue({
      ok: true,
      status: 200,
      url: "/?error=CredentialsSignin",
    });

    render(<LoginForm returnTo="/workspace" />);

    await user.type(screen.getByLabelText("Email"), "reviewer@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password was not accepted. Check both fields and try again.",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("focuses the summary on service errors and states that the password was not saved", async () => {
    const user = userEvent.setup();
    mockSignIn.mockResolvedValue({ error: "Configuration" });

    render(<LoginForm returnTo="/workspace" />);

    await user.type(screen.getByLabelText("Email"), "reviewer@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const summary = await screen.findByRole("alert", { name: "There is a problem" });
    await waitFor(() => {
      expect(summary).toHaveFocus();
    });
    expect(summary).toHaveTextContent("Your password was not saved.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("prevents double submit while sign-in is pending", async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<{ url?: string | null }>();
    mockSignIn.mockReturnValue(deferred.promise);

    render(<LoginForm returnTo="/workspace" />);

    await user.type(screen.getByLabelText("Email"), "reviewer@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");

    const submit = screen.getByRole("button", { name: "Sign in" });
    await user.click(submit);
    await user.click(submit);

    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Signing in..." })).toBeDisabled();

    deferred.resolve({ url: "/workspace" });
  });
});
