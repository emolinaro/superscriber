// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@/lib/command-result";
import type {
  AdministrationMutationResult,
  ChangeAccountRoleActionResult,
  CreateUserInput,
} from "@/server/actions/administration-actions";
import type { ChangeAccountRoleInput } from "@/lib/account-role-management";
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
        activeAssignments: { reviewer: 1, approver: 0 },
        hasActiveOidcIdentity: false,
        isBreakGlassAdministrator: false,
        isSoleActiveAdministrator: false,
        createdAt: "2026-08-01T12:00:00.000Z",
        createdAtLabel: "01 Aug 2026, 12:00 UTC",
        createdAtIso: "2026-08-01T12:00:00.000Z",
      },
    ],
    breakGlass: {
      designation: null,
      viewerIsCustodian: false,
      enrolledKeyCount: 0,
      recoveryCodeCount: 0,
      adminCandidates: [],
    },
    resetMailConfigured: false,
    currentUserId: "admin-1",
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

  it("renders the exact account facts, search, and in-scope lifecycle controls", () => {
    render(<AccountsSection model={createModel()} phoneSafetyMode={false} />);

    expect(screen.getByRole("searchbox", { name: "Search accounts" })).toHaveValue("reviewer");
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Email" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Role" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Active assignments" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Created" })).toBeVisible();
    expect(screen.getByRole("rowheader", { name: "Reviewer One" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Password" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Deactivate account" })).not.toBeInTheDocument();
    // Table and card presentations both render the reset control.
    expect(screen.getAllByRole("button", { name: "Reset password" })).toHaveLength(2);
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

  it("disables submission while pending and immediately renders, deduplicates, and focuses the new row", async () => {
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
    await user.type(
      within(dialog).getByLabelText("Confirm password"),
      "correct horse battery staple",
    );
    await user.selectOptions(within(dialog).getByLabelText("Role"), "reviewer");
    await user.click(within(dialog).getByRole("button", { name: "Create local account" }));

    expect(createUserAction).toHaveBeenCalledWith({
      displayName: "Reviewer Two",
      email: "reviewer2@example.com",
      password: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
      role: "reviewer",
    });
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
        user: {
          id: "user-2",
          displayName: "Reviewer Two",
          email: "reviewer2@example.com",
          role: "reviewer",
          isActive: true,
          activeAssignmentCount: 0,
          createdAt: "2026-08-01T12:10:00.000Z",
          updatedAt: "2026-08-01T12:10:00.000Z",
        },
      },
    });

    await waitFor(() => {
      expect(routerRefreshMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("rowheader", { name: "Reviewer Two" })).toBeVisible();
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Reviewer Two can now sign in as reviewer.",
    );
    const newRowHeader = screen.getByRole("rowheader", { name: "Reviewer Two" });
    const newRow = newRowHeader.closest("tr");
    if (!newRow) {
      throw new Error("Expected the new account row to render.");
    }
    expect(within(newRow).getByRole("cell", { name: "reviewer2@example.com" })).toBeVisible();
    expect(
      within(newRow).getByRole("combobox", { name: "Role for Reviewer Two" }),
    ).toHaveValue("reviewer");
    expect(within(newRow).getByRole("cell", { name: "0" })).toBeVisible();
    expect(within(newRow).getByText("01 Aug 2026, 12:10 UTC")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Create local account" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(document.getElementById("account-row-user-2")).toHaveFocus();
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
              activeAssignments: { reviewer: 0, approver: 0 },
              hasActiveOidcIdentity: false,
              isBreakGlassAdministrator: false,
              isSoleActiveAdministrator: false,
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

    expect(screen.getAllByRole("rowheader", { name: "Reviewer Two" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Create account" }));
    const resetDialog = screen.getByRole("dialog", { name: "Create local account" });
    expect(within(resetDialog).getByLabelText("Name")).toHaveValue("");
    expect(within(resetDialog).getByLabelText("Email")).toHaveValue("");
    expect(within(resetDialog).getByLabelText("Password")).toHaveValue("");
    expect(within(resetDialog).getByLabelText("Confirm password")).toHaveValue("");
    expect(within(resetDialog).getByLabelText("Role")).toHaveValue("reviewer");
  });

  it("sizes the create dialog to its content like the compact casefile modals", async () => {
    const user = userEvent.setup();

    render(<AccountsSection model={createModel()} phoneSafetyMode={false} />);

    await user.click(screen.getByRole("button", { name: "Create account" }));
    const dialog = screen.getByRole("dialog", { name: "Create local account" });
    expect(dialog).toHaveClass("administration-drawer");
    expect(dialog).toHaveClass("administration-drawer--compact");
    expect(within(dialog).getByLabelText("Confirm password")).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("Confirm password"),
    ).toHaveAccessibleName("Confirm password");
  });

  it("blocks a password confirmation mismatch before submit and announces the copy", async () => {
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

    await user.type(within(dialog).getByLabelText("Name"), "Reviewer Two");
    await user.type(within(dialog).getByLabelText("Email"), "reviewer2@example.com");
    const passwordInput = within(dialog).getByLabelText("Password");
    const confirmInput = within(dialog).getByLabelText("Confirm password");
    await user.type(passwordInput, "correct horse battery staple");
    await user.type(confirmInput, "different horse battery staple");

    expect(within(dialog).getByText("Passwords must match.")).toHaveAttribute("role", "alert");
    expect(confirmInput).toHaveAttribute("aria-invalid", "true");
    expect(confirmInput).toHaveAttribute("aria-describedby", "confirmPassword-error");
    expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput.getAttribute("aria-describedby")).toContain("confirmPassword-error");
    const submitButton = within(dialog).getByRole("button", { name: "Create local account" });
    expect(submitButton).toBeDisabled();

    // Enter-key submits bypass the disabled button; the schema match check holds.
    const form = confirmInput.closest("form");
    if (!form) {
      throw new Error("Expected the dialog form to render.");
    }
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(createUserAction).not.toHaveBeenCalled();
    const summary = within(dialog).getByRole("alert", { name: "There is a problem" });
    expect(
      within(summary).getByText("Confirm password - Passwords must match."),
    ).toBeVisible();
    await waitFor(() => {
      expect(confirmInput).toHaveFocus();
    });

    await user.clear(confirmInput);
    await user.type(confirmInput, "correct horse battery staple");
    await waitFor(() => {
      expect(within(dialog).queryByText("Passwords must match.")).not.toBeInTheDocument();
    });
    expect(confirmInput).not.toHaveAttribute("aria-invalid");
    expect(passwordInput).not.toHaveAttribute("aria-invalid");
    expect(submitButton).toBeEnabled();
  });

  it("shares one dirty role state across table and card presentations and Cancel restores focus", async () => {
    const user = userEvent.setup();
    const changeAccountRoleAction = vi.fn(
      async (_input: ChangeAccountRoleInput): Promise<ChangeAccountRoleActionResult> => {
        throw new Error("Role action was not expected during Cancel coverage.");
      },
    );

    render(
      <AccountsSection
        changeAccountRoleAction={changeAccountRoleAction}
        model={createModel()}
        phoneSafetyMode={false}
      />,
    );

    const selects = screen.getAllByRole("combobox", {
      name: "Role for Reviewer One",
    });
    expect(selects).toHaveLength(2);
    expect(new Set(selects.map((select) => select.id)).size).toBe(2);

    await user.selectOptions(selects[0]!, "approver");
    expect(selects[0]).toHaveValue("approver");
    expect(selects[1]).toHaveValue("approver");
    expect(
      screen.getAllByRole("textbox", {
        name: "Change reason for Reviewer One",
      }),
    ).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", {
          name: "Change reason for Reviewer One",
        }),
      ).not.toBeInTheDocument();
      expect(selects[0]).toHaveValue("reviewer");
      expect(selects[0]).toHaveFocus();
    });
    expect(changeAccountRoleAction).not.toHaveBeenCalled();
  });

  it("validates reason, submits once, disables all mutations, and focuses successful role", async () => {
    const user = userEvent.setup();
    let resolveAction: ((result: ChangeAccountRoleActionResult) => void) | undefined;
    const changeAccountRoleAction: (
      input: ChangeAccountRoleInput,
    ) => Promise<ChangeAccountRoleActionResult> = vi.fn(
      () =>
        new Promise<ChangeAccountRoleActionResult>((resolve) => {
          resolveAction = resolve;
        }),
    );

    render(
      <AccountsSection
        changeAccountRoleAction={changeAccountRoleAction}
        model={createModel()}
        phoneSafetyMode={false}
      />,
    );

    const select = screen.getAllByRole("combobox", {
      name: "Role for Reviewer One",
    })[0]!;
    await user.selectOptions(select, "approver");
    const reason = screen.getAllByRole("textbox", {
      name: "Change reason for Reviewer One",
    })[0]!;
    await user.type(reason, "too short");
    await user.click(screen.getAllByRole("button", { name: "Save role" })[0]!);
    await waitFor(() => expect(reason).toHaveFocus());
    expect(changeAccountRoleAction).not.toHaveBeenCalled();

    await user.clear(reason);
    await user.type(reason, "Duties changed for coverage.");
    await user.click(screen.getAllByRole("button", { name: "Save role" })[0]!);
    await user.keyboard("{Enter}{Enter}");

    expect(changeAccountRoleAction).toHaveBeenCalledTimes(1);
    expect(changeAccountRoleAction).toHaveBeenCalledWith({
      userId: "user-1",
      expectedRole: "reviewer",
      newRole: "approver",
      reason: "Duties changed for coverage.",
    });
    expect(screen.getAllByRole("button", { name: "Saving role..." })).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeDisabled();
    for (const roleSelect of screen.getAllByRole("combobox", {
      name: "Role for Reviewer One",
    })) {
      expect(roleSelect).toBeDisabled();
    }

    resolveAction?.({
      ok: true,
      notice:
        "Reviewer One's role changed from Reviewer to Approver. Active sessions were revoked; they must sign in again.",
      data: {
        user: {
          id: "user-1",
          displayName: "Reviewer One",
          email: "reviewer1@example.com",
          role: "approver",
          isActive: true,
          activeAssignmentCount: 0,
          createdAt: "2026-08-01T12:00:00.000Z",
          updatedAt: "2026-08-01T12:30:00.000Z",
        },
        oldRole: "reviewer",
        newRole: "approver",
        revokedSessionCount: 1,
        actorMustRelogin: false,
        resultingAuthVersion: 2,
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Reviewer One's role changed from Reviewer to Approver",
      );
      expect(
        screen.getAllByRole("combobox", { name: "Role for Reviewer One" })[0],
      ).toHaveValue("approver");
      expect(
        screen.getAllByRole("combobox", { name: "Role for Reviewer One" })[0],
      ).toHaveFocus();
    });
    expect(routerRefreshMock).toHaveBeenCalled();
  });

  it("retains governance input and focuses an actionable server error", async () => {
    const user = userEvent.setup();
    const changeAccountRoleAction = vi.fn().mockResolvedValue({
      ok: false,
      code: "ASSIGNMENTS_INCOMPATIBLE",
      message:
        "Remove the listed active assignments before changing this account to Approver.",
      assignmentBlockers: {
        total: 1,
        byRole: [
          { role: "reviewer", count: 1, recordingTitles: ["Record one"] },
        ],
        managementHref:
          "/administration?section=assignments&status=active&userId=user-1",
      },
    } satisfies ChangeAccountRoleActionResult);

    render(
      <AccountsSection
        changeAccountRoleAction={changeAccountRoleAction}
        model={createModel()}
        phoneSafetyMode={false}
      />,
    );
    await user.selectOptions(
      screen.getAllByRole("combobox", { name: "Role for Reviewer One" })[0]!,
      "approver",
    );
    const reason = screen.getAllByRole("textbox", {
      name: "Change reason for Reviewer One",
    })[0]!;
    await user.type(reason, "Duties changed for coverage.");
    await user.click(screen.getAllByRole("button", { name: "Save role" })[0]!);

    await waitFor(() => {
      expect(screen.getAllByRole("alert")[0]).toHaveFocus();
    });
    expect(
      screen.getAllByRole("textbox", {
        name: "Change reason for Reviewer One",
      })[0],
    ).toHaveValue("Duties changed for coverage.");
    expect(screen.getAllByText("Record one").length).toBeGreaterThan(0);
  });

  it("navigates immediately after self-role success", async () => {
    const user = userEvent.setup();
    const navigateToSignIn = vi.fn();
    const changeAccountRoleAction = vi.fn().mockResolvedValue({
      ok: true,
      notice: "Self role changed.",
      data: {
        user: {
          id: "user-1",
          displayName: "Reviewer One",
          email: "reviewer1@example.com",
          role: "uploader",
          isActive: true,
          activeAssignmentCount: 0,
          createdAt: "2026-08-01T12:00:00.000Z",
          updatedAt: "2026-08-01T12:30:00.000Z",
        },
        oldRole: "reviewer",
        newRole: "uploader",
        revokedSessionCount: 1,
        actorMustRelogin: true,
        resultingAuthVersion: 2,
      },
    } satisfies ChangeAccountRoleActionResult);

    render(
      <AccountsSection
        changeAccountRoleAction={changeAccountRoleAction}
        model={createModel()}
        navigateToSignIn={navigateToSignIn}
        phoneSafetyMode={false}
      />,
    );
    await user.selectOptions(
      screen.getAllByRole("combobox", { name: "Role for Reviewer One" })[0]!,
      "uploader",
    );
    await user.type(
      screen.getAllByRole("textbox", {
        name: "Change reason for Reviewer One",
      })[0]!,
      "Self duties changed safely.",
    );
    await user.click(screen.getAllByRole("button", { name: "Save role" })[0]!);

    await waitFor(() => {
      expect(navigateToSignIn).toHaveBeenCalledWith("/?reason=role-changed");
    });
  });

  it("discards an unsaved role draft when phone safety begins", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AccountsSection model={createModel()} phoneSafetyMode={false} />,
    );
    await user.selectOptions(
      screen.getAllByRole("combobox", { name: "Role for Reviewer One" })[0]!,
      "approver",
    );
    await user.type(
      screen.getAllByRole("textbox", {
        name: "Change reason for Reviewer One",
      })[0]!,
      "Unsaved duties changed.",
    );

    rerender(<AccountsSection model={createModel()} phoneSafetyMode />);
    expect(
      screen.queryByRole("combobox", { name: "Role for Reviewer One" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);

    rerender(<AccountsSection model={createModel()} phoneSafetyMode={false} />);
    expect(
      screen.queryByRole("textbox", {
        name: "Change reason for Reviewer One",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("combobox", { name: "Role for Reviewer One" })[0],
    ).toHaveValue("reviewer");
  });

  it("keeps account facts visible on phone while hiding the create drawer", () => {
    render(<AccountsSection model={createModel()} phoneSafetyMode={true} />);

    expect(screen.getByRole("rowheader", { name: "Reviewer One" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Create local account" })).not.toBeInTheDocument();
  });
});
