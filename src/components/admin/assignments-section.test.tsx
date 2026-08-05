// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdministrationAssignmentsViewModel } from "@/server/administration/service";
import { AssignmentsSection } from "./assignments-section";

const routerRefreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
  }),
}));

function createActiveModel(
  overrides: Partial<AdministrationAssignmentsViewModel> = {},
): AdministrationAssignmentsViewModel {
  return {
    section: "assignments",
    filters: {
      recordingId: null,
      userId: null,
      role: null,
      status: "active",
      from: null,
      to: null,
    },
    columns: [
      { id: "recording", label: "Recording" },
      { id: "stage", label: "Stage" },
      { id: "user", label: "Assignee" },
      { id: "role", label: "Role" },
      { id: "updatedAt", label: "Updated" },
      { id: "actions", label: "Controls" },
    ],
    stateOptions: [
      { id: "active", label: "Active" },
      { id: "history", label: "History" },
    ],
    recordings: [
      {
        recordingId: "rec-actionable",
        title: "Actionable recording",
        stageLabel: "Draft review",
        compatibility: {
          reviewer: { allowed: true, label: "Actionable", reason: null },
          approver: { allowed: true, label: "Actionable", reason: null },
        },
      },
      {
        recordingId: "rec-waiting",
        title: "Waiting recording",
        stageLabel: "Transcribing",
        compatibility: {
          reviewer: { allowed: true, label: "Waiting", reason: null },
          approver: { allowed: true, label: "Waiting", reason: null },
        },
      },
      {
        recordingId: "rec-approved",
        title: "Approved recording",
        stageLabel: "Approved",
        compatibility: {
          reviewer: {
            allowed: false,
            label: "Unavailable",
            reason: "Reviewer work cannot be assigned to an approved casefile.",
          },
          approver: { allowed: true, label: "Reopen authority", reason: null },
        },
      },
      {
        recordingId: "rec-failed",
        title: "Failed ingest recording",
        stageLabel: "Needs ingest attention",
        compatibility: {
          reviewer: {
            allowed: false,
            label: "Unavailable",
            reason: "Review work cannot be assigned until ingest recovers.",
          },
          approver: {
            allowed: false,
            label: "Unavailable",
            reason: "Review work cannot be assigned until ingest recovers.",
          },
        },
      },
    ],
    assignableUsers: [
      { id: "user-reviewer", displayName: "Reviewer One", role: "reviewer" },
      { id: "user-approver", displayName: "Approver One", role: "approver" },
    ],
    assignments: [
      {
        id: "assign-1",
        recordingId: "rec-actionable",
        recordingTitle: "Actionable recording",
        stageLabel: "Draft review",
        userId: "user-reviewer",
        userDisplayName: "Reviewer One",
        userEmail: "reviewer@example.com",
        role: "reviewer",
        roleLabel: "Reviewer",
        status: "active",
        statusLabel: "Active",
        outcomeLabel: null,
        completedRevisionId: null,
        completedRevisionLabel: null,
        updatedAt: "2026-08-01T12:05:00.000Z",
        updatedAtLabel: "01 Aug 2026, 12:05 UTC",
        updatedAtIso: "2026-08-01T12:05:00.000Z",
        href: "/recordings/rec-actionable",
      },
    ],
    ...overrides,
  };
}

function createHistoryModel(): AdministrationAssignmentsViewModel {
  return createActiveModel({
    filters: {
      recordingId: "rec-approved",
      userId: "user-reviewer",
      role: "reviewer",
      status: "history",
      from: "2026-08-01T12:00:00.000Z",
      to: "2026-08-01T13:00:00.000Z",
    },
    columns: [
      { id: "recording", label: "Recording" },
      { id: "user", label: "Assignee" },
      { id: "role", label: "Role" },
      { id: "outcome", label: "Outcome" },
      { id: "completedRevision", label: "Completed revision" },
      { id: "updatedAt", label: "Updated" },
    ],
    assignments: [
      {
        id: "assign-completed",
        recordingId: "rec-approved",
        recordingTitle: "Approved recording",
        stageLabel: "Approved",
        userId: "user-reviewer",
        userDisplayName: "Reviewer One",
        userEmail: "reviewer@example.com",
        role: "reviewer",
        roleLabel: "Reviewer",
        status: "completed",
        statusLabel: "Completed",
        outcomeLabel: "Completed",
        completedRevisionId: "rev-approved",
        completedRevisionLabel: "Approved v1",
        updatedAt: "2026-08-01T12:30:00.000Z",
        updatedAtLabel: "01 Aug 2026, 12:30 UTC",
        updatedAtIso: "2026-08-01T12:30:00.000Z",
        href: "/recordings/rec-approved?revision=rev-approved",
      },
      {
        id: "assign-removed",
        recordingId: "rec-approved",
        recordingTitle: "Approved recording",
        stageLabel: "Approved",
        userId: "user-approver",
        userDisplayName: "Approver One",
        userEmail: "approver@example.com",
        role: "approver",
        roleLabel: "Approver",
        status: "removed",
        statusLabel: "Removed",
        outcomeLabel: "Removed",
        completedRevisionId: null,
        completedRevisionLabel: "-",
        updatedAt: "2026-08-01T12:40:00.000Z",
        updatedAtLabel: "01 Aug 2026, 12:40 UTC",
        updatedAtIso: "2026-08-01T12:40:00.000Z",
        href: "/recordings/rec-approved",
      },
    ],
  });
}

describe("AssignmentsSection", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to Active with the exact ledger columns and history link", () => {
    render(<AssignmentsSection model={createActiveModel()} phoneSafetyMode={false} />);

    expect(screen.getByRole("link", { name: "Active" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "History" })).toBeVisible();
    for (const name of ["Recording", "Stage", "Assignee", "Role", "Updated", "Controls"]) {
      expect(screen.getByRole("columnheader", { name })).toBeVisible();
    }
    expect(screen.getByRole("rowheader", { name: "Actionable recording" })).toBeVisible();
    expect(screen.getAllByText("01 Aug 2026, 12:05 UTC")[0]).toBeVisible();
  });

  it("filters reviewer and approver users and shows truthful compatibility before submit", async () => {
    const user = userEvent.setup();
    const assignRecordingAction = vi.fn();

    render(
      <AssignmentsSection
        assignRecordingAction={assignRecordingAction}
        model={createActiveModel()}
        phoneSafetyMode={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Assign work" }));

    const dialog = screen.getByRole("dialog", { name: "Assign governed work" });
    expect(within(dialog).getByRole("option", { name: "Reviewer One - Reviewer" })).toBeVisible();
    expect(within(dialog).getByRole("option", { name: "Approver One - Approver" })).toBeVisible();

    expect(within(dialog).getByLabelText("Recording search")).toBeVisible();
    expect(within(dialog).getByLabelText("Assigned user search")).toBeVisible();
    const [recordingSelect, userSelect] = within(dialog).getAllByRole("combobox");
    await user.selectOptions(userSelect, "user-reviewer");
    await user.selectOptions(
      recordingSelect,
      within(dialog).getByRole("option", { name: "Waiting recording" }),
    );
    expect(within(dialog).getByText("Current state: Waiting")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Assign recording" })).toBeEnabled();

    await user.selectOptions(
      recordingSelect,
      within(dialog).getByRole("option", { name: "Approved recording" }),
    );
    expect(
      within(dialog).getByText("Reviewer work cannot be assigned to an approved casefile."),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Assign recording" })).toBeDisabled();

    await user.selectOptions(userSelect, "user-approver");
    expect(within(dialog).getByText("Current state: Reopen authority")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Assign recording" })).toBeEnabled();

    await user.selectOptions(
      recordingSelect,
      within(dialog).getByRole("option", { name: "Failed ingest recording" }),
    );
    expect(
      within(dialog).getByText("Review work cannot be assigned until ingest recovers."),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Assign recording" })).toBeDisabled();
    expect(assignRecordingAction).not.toHaveBeenCalled();
  });

  it("renders History with outcome, completed revision, and UTC filters", () => {
    render(<AssignmentsSection model={createHistoryModel()} phoneSafetyMode={false} />);

    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Updated from (UTC)")).toHaveValue("2026-08-01T12:00:00.000Z");
    expect(screen.getByLabelText("Updated to (UTC)")).toHaveValue("2026-08-01T13:00:00.000Z");
    expect(screen.getByRole("columnheader", { name: "Outcome" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Completed revision" })).toBeVisible();
    expect(screen.getAllByText("Completed")[0]).toBeVisible();
    expect(screen.getAllByText("Approved v1")[0]).toBeVisible();
    expect(screen.getAllByText("Removed")[0]).toBeVisible();
    expect(screen.getAllByText("-")[0]).toBeVisible();
  });

  it(
    "confirms removal with immediate access revocation and retained history",
    { timeout: 20_000 },
    async () => {
    const user = userEvent.setup();
    const removeRecordingAssignmentAction = vi.fn().mockResolvedValue({
      ok: true,
      notice: "Recording assignment removed.",
      data: {
        href: "/administration?section=assignments",
        assignmentId: "assign-1",
      },
    });

    render(
      <AssignmentsSection
        model={createActiveModel()}
        phoneSafetyMode={false}
        removeRecordingAssignmentAction={removeRecordingAssignmentAction}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "Remove assignment" })[0]);

    const dialog = screen.getByRole("dialog", { name: "Remove assignment" });
    expect(within(dialog).getByText("Recording: Actionable recording")).toBeVisible();
    expect(within(dialog).getByText("Assigned user: Reviewer One")) .toBeVisible();
    expect(
      within(dialog).getByText(
        "Removing this assignment revokes access immediately and keeps the assignment history.",
      ),
    ).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Remove assignment" }));

    await waitFor(() => {
      expect(removeRecordingAssignmentAction).toHaveBeenCalledWith({ assignmentId: "assign-1" });
      expect(routerRefreshMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog", { name: "Remove assignment" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Recording assignment removed.");
    // Focus moves on the next animation frame after dialog teardown; under a
    // loaded parallel suite that frame can take well over a second.
    await waitFor(
      () => {
        expect(screen.getByRole("heading", { name: "Assignments" })).toHaveFocus();
      },
      { timeout: 5_000 },
    );
  });

  it("keeps active and history inspection visible on phone without drawers or remove controls", () => {
    const { rerender } = render(
      <AssignmentsSection model={createActiveModel()} phoneSafetyMode={true} />,
    );

    expect(screen.getAllByRole("rowheader", { name: "Actionable recording" })[0]).toBeVisible();
    expect(screen.queryByRole("button", { name: "Assign work" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove assignment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Assign governed work" })).not.toBeInTheDocument();

    rerender(<AssignmentsSection model={createHistoryModel()} phoneSafetyMode={true} />);
    expect(screen.getAllByText("Approved v1")[0]).toBeVisible();
    expect(screen.queryByRole("button", { name: "Assign work" })).not.toBeInTheDocument();
  });
});
