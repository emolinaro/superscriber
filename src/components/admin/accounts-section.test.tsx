// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@/lib/command-result";
import type {
  AdministrationMutationResult,
  CreateUserInput,
} from "@/server/actions/administration-actions";
import type { AdministrationAccountsViewModel } from "@/server/administration/service";
import { AccountsSection } from "./accounts-section";

const routerRefreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
  }),
}));

function createModel(
  overrides: Partial<AdministrationAccountsViewModel> = {},
): AdministrationAccountsViewModel {
  return {
    section: "accounts",
    query: "reviewer",
    columns: [
      { id: "displayName", label: "Name" },
      { id: "email", label: "Email" },
      { id: "role", label: "Role" },
      { id: "activeAssignmentCount", label: "Active assignments" },
      { id: "createdAt", label: "Created" },
    ],
    users: [
      {
        id: "user-1",
        displayName: "Reviewer One",
        email: "reviewer1@example.com",
        role: "reviewer",
        roleLabel: "Reviewer",
        activeAssignmentCount: 1,
        createdAt: "2026-08-01T12:00:00.000Z",
        createdAtLabel: "01 Aug 2026, 12:00 UTC",
        createdAtIso: "2026-08-01T12:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("AccountsSection", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the exact account facts and search without lifecycle controls", () => {
    render(<AccountsSection model={createModel()} phoneSafetyMode={false} />);

    expect(screen.getByRole("searchbox", { name: "Search accounts" })).toHaveValue("reviewer");
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Email" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Role" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Active assignments" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Created" })).toBeVisible();
    expect(screen.getByRole("rowheader", { name: "Reviewer One" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Deactivate account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change role" })).not.toBeInTheDocument();
  });

  it("uses localUserSchema validation with an error summary and focus", async () => {
    const user = userEvent.setup();
    const createUserAction = vi.fn();

    render(
      <AccountsSection
        createUserAction={createUserAction}
        model={createModel()}
        phoneSafetyMode={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create account" }));
    const dialog = screen.getByRole("dialog", { name: "Create local account" });
    await user.click(within(dialog).getByRole("button", { name: "Create local account" }));

    const summary = within(dialog).getByRole("alert", { name: "There is a problem" });
    await waitFor(() => {
      expect(summary).toHaveFocus();
    });
    expect(screen.getByText("Name - Enter the user's name.")).toBeVisible();
    expect(screen.getByText("Email - Enter a valid email address.")).toBeVisible();
    expect(screen.getByText("Password - Use at least 10 characters.")).toBeVisible();
    expect(createUserAction).not.toHaveBeenCalled();
  });

  it("disables submission while pending and announces success before focusing the new row", async () => {
    const user = userEvent.setup();
    const resolveActionRef: {
      current?: (value: CommandResult<AdministrationMutationResult>) => void;
    } = {};
    const createUserAction: (
      input: CreateUserInput,
    ) => Promise<CommandResult<AdministrationMutationResult>> = vi.fn(
      () =>
        new Promise<CommandResult<AdministrationMutationResult>>((resolve) => {
          resolveActionRef.current = resolve;
        }),
    );
    const initialModel = createModel();
    const { rerender } = render(
      <AccountsSection
        createUserAction={createUserAction}
        model={initialModel}
        phoneSafetyMode={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create account" }));
    const dialog = screen.getByRole("dialog", { name: "Create local account" });
    await user.type(within(dialog).getByLabelText("Name"), "Reviewer Two");
    await user.type(within(dialog).getByLabelText("Email"), "reviewer2@example.com");
    await user.type(within(dialog).getByLabelText("Password"), "correct horse battery staple");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "reviewer");
    await user.click(within(dialog).getByRole("button", { name: "Create local account" }));

    expect(screen.getByRole("button", { name: "Creating account..." })).toBeDisabled();

    if (!resolveActionRef.current) {
      throw new Error("Expected create account action to be pending.");
    }

    resolveActionRef.current({
      ok: true,
      notice: "Reviewer Two can now sign in as reviewer.",
      data: {
        href: "/administration?section=accounts",
        userId: "user-2",
      },
    });

    await waitFor(() => {
      expect(routerRefreshMock).toHaveBeenCalledTimes(1);
    });

    rerender(
      <AccountsSection
        createUserAction={createUserAction}
        model={createModel({
          users: [
            {
              id: "user-2",
              displayName: "Reviewer Two",
              email: "reviewer2@example.com",
              role: "reviewer",
              roleLabel: "Reviewer",
              activeAssignmentCount: 0,
              createdAt: "2026-08-01T12:10:00.000Z",
              createdAtLabel: "01 Aug 2026, 12:10 UTC",
              createdAtIso: "2026-08-01T12:10:00.000Z",
            },
            ...initialModel.users,
          ],
        })}
        phoneSafetyMode={false}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Reviewer Two can now sign in as reviewer.",
    );
    await waitFor(() => {
      expect(document.getElementById("account-row-user-2")).toHaveFocus();
    });
  });

  it("keeps account facts visible on phone while hiding the create drawer", () => {
    render(<AccountsSection model={createModel()} phoneSafetyMode={true} />);

    expect(screen.getByRole("rowheader", { name: "Reviewer One" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Create local account" })).not.toBeInTheDocument();
  });
});
