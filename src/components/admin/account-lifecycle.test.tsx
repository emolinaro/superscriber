// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccountLifecycleModal } from "./account-lifecycle";
import { TemporaryAccountModal } from "./temporary-account";
afterEach(cleanup);
const account = {
  id: "target",
  displayName: "Reviewer",
  isActive: true,
  hasActiveOidcIdentity: true,
  activeAssignmentCount: 2,
};
it("requires a reason, describes OIDC and assignment impact, and recovers from a failure", async () => {
  const action = vi.fn().mockResolvedValue({
    ok: false,
    code: "ACCESS_DENIED",
    message: "The last active administrator must remain active.",
  });
  const user = userEvent.setup();
  render(
    <AccountLifecycleModal
      account={account}
      kind="deactivate"
      currentUserId="admin"
      action={action}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByText(/identity provider/i)).toBeVisible();
  expect(screen.getByText(/2 active assignments/i)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Deactivate account" }));
  expect(action).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Reason (required)")).toHaveFocus();
  await user.type(screen.getByLabelText("Reason (required)"), "Staff leave");
  await user.click(screen.getByRole("button", { name: "Deactivate account" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      /last active administrator/,
    ),
  );
  expect(screen.getByRole("alert")).toHaveFocus();
  expect(action).toHaveBeenCalledWith({
    userId: "target",
    action: "deactivate",
    expectedIsActive: true,
    expectedActorUserId: "admin",
    reason: "Staff leave",
  });
});
it("describes released email behavior for removal", () => {
  render(
    <AccountLifecycleModal
      account={account}
      kind="remove"
      currentUserId="admin"
      action={vi.fn()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );

  expect(screen.getByText(/release its local email address/i)).toBeVisible();
});
it("discloses a generated password only until the confirmation closes", async () => {
  const user = userEvent.setup();
  const action = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      user: { id: "new", displayName: "New Reviewer" },
      temporaryPassword: "test-only-generated-secret",
    },
  });
  const onClose = vi.fn();
  const { unmount } = render(
    <TemporaryAccountModal
      currentUserId="admin"
      action={action}
      onClose={onClose}
      onCreated={vi.fn()}
    />,
  );
  await user.type(screen.getByLabelText("Name"), "New Reviewer");
  await user.type(screen.getByLabelText("Email"), "new@example.com");
  await user.type(screen.getByLabelText("Reason (required)"), "New colleague");
  await user.click(screen.getByRole("button", { name: "Create account" }));
  expect(await screen.findByLabelText("Temporary password")).toHaveValue(
    "test-only-generated-secret",
  );
  expect(screen.getByText(/expires at first sign-in/i)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(
    screen.queryByDisplayValue("test-only-generated-secret"),
  ).not.toBeInTheDocument();
  unmount();
  render(
    <TemporaryAccountModal
      currentUserId="admin"
      action={action}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  expect(screen.queryByLabelText("Temporary password")).not.toBeInTheDocument();
});
