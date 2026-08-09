// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdministrationAccountsViewModel } from "@/server/administration/service";
import {
  AccountRoleEditor,
  emptyRoleEditorState,
  type RoleEditorState,
} from "./account-role-editor";

type AccountRow = AdministrationAccountsViewModel["users"][number];

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "user-1",
    displayName: "Reviewer One",
    email: "reviewer@example.com",
    role: "reviewer",
    roleLabel: "Reviewer",
    activeAssignmentCount: 0,
    activeAssignments: { reviewer: 0, approver: 0 },
    hasActiveOidcIdentity: false,
    isBreakGlassAdministrator: false,
    isSoleActiveAdministrator: false,
    createdAt: "2026-08-01T12:00:00.000Z",
    createdAtLabel: "01 Aug 2026, 12:00 UTC",
    createdAtIso: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function dirtyState(overrides: Partial<RoleEditorState> = {}): RoleEditorState {
  return {
    selectedRole: "approver",
    reason: "Operational duties changed.",
    phase: "dirty",
    fieldError: null,
    operationError: null,
    ...overrides,
  };
}

function renderEditor(
  options: {
    user?: AccountRow;
    presentationId?: string;
    state?: RoleEditorState;
    mutationsDisabled?: boolean;
    onSelectedRoleChange?: (role: AccountRow["role"]) => void;
    onReasonChange?: (reason: string) => void;
    onSubmit?: () => void;
    onCancel?: () => void;
  } = {},
) {
  const handlers = {
    onSelectedRoleChange: options.onSelectedRoleChange ?? vi.fn(),
    onReasonChange: options.onReasonChange ?? vi.fn(),
    onSubmit: options.onSubmit ?? vi.fn(),
    onCancel: options.onCancel ?? vi.fn(),
  };
  render(
    <AccountRoleEditor
      mutationsDisabled={options.mutationsDisabled ?? false}
      presentationId={options.presentationId ?? "table-user-1"}
      state={options.state ?? emptyRoleEditorState("reviewer")}
      user={options.user ?? account()}
      {...handlers}
    />,
  );
  return handlers;
}

afterEach(cleanup);

describe("AccountRoleEditor", () => {
  it("renders a uniquely labelled native select in persisted state", () => {
    const { rerender } = render(
      <AccountRoleEditor
        mutationsDisabled={false}
        onCancel={vi.fn()}
        onReasonChange={vi.fn()}
        onSelectedRoleChange={vi.fn()}
        onSubmit={vi.fn()}
        presentationId="table-user-1"
        state={emptyRoleEditorState("reviewer")}
        user={account()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Role for Reviewer One" })).toHaveValue(
      "reviewer",
    );
    expect(screen.queryByLabelText("Change reason for Reviewer One")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save role" })).not.toBeInTheDocument();

    const tableId = screen.getByRole("combobox").id;
    rerender(
      <AccountRoleEditor
        mutationsDisabled={false}
        onCancel={vi.fn()}
        onReasonChange={vi.fn()}
        onSelectedRoleChange={vi.fn()}
        onSubmit={vi.fn()}
        presentationId="card-user-1"
        state={emptyRoleEditorState("reviewer")}
        user={account()}
      />,
    );
    expect(screen.getByRole("combobox").id).not.toBe(tableId);
  });

  it("renders dirty controls in keyboard order and reports controlled edits", async () => {
    const user = userEvent.setup();
    const handlers = renderEditor({ state: dirtyState() });
    const form = screen.getByRole("combobox").closest("form");
    if (!form) {
      throw new Error("Expected inline role form.");
    }

    const reason = within(form).getByRole("textbox", {
      name: "Change reason for Reviewer One",
    });
    const save = within(form).getByRole("button", { name: "Save role" });
    const cancel = within(form).getByRole("button", { name: "Cancel" });
    expect(reason.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(save.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.selectOptions(within(form).getByRole("combobox"), "admin");
    expect(handlers.onSelectedRoleChange).toHaveBeenCalledWith("admin");
    fireEvent.change(reason, { target: { value: "A revised reason" } });
    expect(handlers.onReasonChange).toHaveBeenCalledWith("A revised reason");
    await user.click(save);
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("shows linked identity and non-authoritative protection guidance without disabling save", () => {
    renderEditor({
      user: account({
        role: "admin",
        roleLabel: "Admin",
        hasActiveOidcIdentity: true,
        isBreakGlassAdministrator: true,
        isSoleActiveAdministrator: true,
        activeAssignmentCount: 2,
        activeAssignments: { reviewer: 2, approver: 0 },
      }),
      state: dirtyState({ selectedRole: "uploader" }),
    });

    expect(screen.getByText(/Set exactly one Authentik role group for Uploader/)).toBeVisible();
    expect(screen.getByText(/designated break-glass administrator/)).toBeVisible();
    expect(screen.getByText(/At least one active administrator must remain/)).toBeVisible();
    expect(screen.getByText(/2 active Reviewer assignments/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save role" })).toBeEnabled();
  });

  it("associates field errors only with reason and renders actionable blocker details", () => {
    renderEditor({
      state: dirtyState({
        phase: "error",
        fieldError: "Enter a change reason between 10 and 500 characters.",
        operationError: {
          code: "ASSIGNMENTS_INCOMPATIBLE",
          message:
            "Remove the listed active assignments before changing this account to Approver.",
          assignmentBlockers: {
            total: 4,
            byRole: [
              {
                role: "reviewer",
                count: 4,
                recordingTitles: ["Alpha", "Bravo", "Charlie"],
              },
            ],
            managementHref:
              "/administration?section=assignments&status=active&userId=user-1",
          },
        },
      }),
    });

    const select = screen.getByRole("combobox");
    const reason = screen.getByRole("textbox", {
      name: "Change reason for Reviewer One",
    });
    expect(select).not.toHaveAttribute("aria-invalid");
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(
      /Enter a change reason between 10 and 500 characters\./,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("tabindex", "-1");
    expect(alert).toHaveTextContent("Alpha");
    expect(alert).toHaveTextContent("and 1 more");
    expect(
      within(alert).getByRole("link", { name: "Open active assignments" }),
    ).toHaveAttribute(
      "href",
      "/administration?section=assignments&status=active&userId=user-1",
    );
  });

  it("disables every mutation while pending and ignores Escape", async () => {
    const user = userEvent.setup();
    const handlers = renderEditor({
      state: dirtyState({ phase: "pending" }),
    });
    const form = screen.getByRole("combobox").closest("form");
    if (!form) {
      throw new Error("Expected inline role form.");
    }

    expect(form).toHaveAttribute("aria-busy", "true");
    expect(within(form).getByRole("combobox")).toBeDisabled();
    expect(within(form).getByRole("textbox")).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Saving role..." })).toBeDisabled();
    expect(within(form).getByRole("button", { name: "Cancel" })).toBeDisabled();
    form.focus();
    await user.keyboard("{Escape}");
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("submits with Enter and cancels dirty or error state with Escape", async () => {
    const user = userEvent.setup();
    const handlers = renderEditor({ state: dirtyState() });
    const reason = screen.getByRole("textbox", {
      name: "Change reason for Reviewer One",
    });

    reason.focus();
    await user.keyboard("{Enter}");
    expect(handlers.onSubmit).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });
});
