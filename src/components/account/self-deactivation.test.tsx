// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelfDeactivation } from "./self-deactivation";
import { hasIntentionalSignOut } from "@/lib/signed-out-marker";
const signOut = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signOut }));
afterEach(cleanup);
beforeEach(() => {
  signOut.mockReset();
  sessionStorage.clear();
});
it("requires a reason and returns a governed denial without signing out", async () => {
  const user = userEvent.setup();
  const action = vi.fn().mockResolvedValue({
    ok: false,
    message: "The last active administrator must remain active.",
  });
  render(<SelfDeactivation userId="admin" action={action} />);
  await user.click(
    screen.getByRole("button", { name: "Deactivate my account" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Deactivate and sign out" }),
  );
  expect(action).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Reason (required)"), "Taking a break");
  await user.click(
    screen.getByRole("button", { name: "Deactivate and sign out" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      /last active administrator/,
    ),
  );
  expect(screen.getByRole("alert")).toHaveFocus();
  expect(signOut).not.toHaveBeenCalled();
  expect(hasIntentionalSignOut()).toBe(false);
});
it("binds the current user and signs out after successful self-deactivation", async () => {
  const user = userEvent.setup();
  const action = vi
    .fn()
    .mockResolvedValue({ ok: true, data: { userId: "self" } });
  render(<SelfDeactivation userId="self" action={action} />);
  await user.click(
    screen.getByRole("button", { name: "Deactivate my account" }),
  );
  await user.type(screen.getByLabelText("Reason (required)"), "Taking a break");
  await user.click(
    screen.getByRole("button", { name: "Deactivate and sign out" }),
  );
  await waitFor(() =>
    expect(signOut).toHaveBeenCalledWith({
      callbackUrl: "/?reason=account-deactivated",
      redirect: true,
    }),
  );
  expect(action).toHaveBeenCalledWith({
    expectedActorUserId: "self",
    reason: "Taking a break",
  });
});
