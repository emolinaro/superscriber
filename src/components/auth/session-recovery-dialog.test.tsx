// @vitest-environment jsdom

import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRecoveryDialog } from "./session-recovery-dialog";

const { mockSignIn } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  signIn: mockSignIn,
}));

function RecoveryHarness() {
  const [open, setOpen] = useState(false);
  const [attemptCount, setAttemptCount] = useState(0);
  const invokingControlRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={invokingControlRef}
        type="button"
        onClick={() => {
          setAttemptCount((count) => count + 1);
          setOpen(true);
        }}
      >
        Save draft
      </button>
      <p>Attempts: {attemptCount}</p>
      <SessionRecoveryDialog
        open={open}
        onClose={() => setOpen(false)}
        onRecovered={() => {
          setOpen(false);
          invokingControlRef.current?.focus();
        }}
      />
    </>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SessionRecoveryDialog", () => {
  beforeEach(() => {
    mockSignIn.mockReset();
  });

  it("uses redirect:false credentials, restores focus, and does not retry the prior command", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);
    mockSignIn.mockResolvedValue({ ok: true, url: "/workspace" });

    render(<RecoveryHarness />, { container: appRoot });

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await user.type(screen.getByLabelText("Email"), "reviewer@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Recover session" }));

    expect(mockSignIn).toHaveBeenCalledWith("credentials", {
      email: "reviewer@example.com",
      password: "correct horse battery staple",
      redirect: false,
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save draft" })).toHaveFocus();
    });
    expect(screen.getByText("Attempts: 1")).toBeVisible();
  });
});
