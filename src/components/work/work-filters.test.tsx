// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRole } from "@/domain/models";
import type { WorkInboxFilters } from "@/server/work-inbox/service";
import { WorkFilters } from "./work-filters";

const { mockPush, mockReplace } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function filters(overrides: Partial<WorkInboxFilters> = {}): WorkInboxFilters {
  return {
    tab: "to-review",
    query: "",
    stage: null,
    source: null,
    assignmentUserId: null,
    sort: "default",
    ...overrides,
  };
}

function renderFilters(role: UserRole, value: WorkInboxFilters = filters(), resultCount = 2) {
  return render(<WorkFilters filters={value} resultCount={resultCount} role={role} />);
}

describe("WorkFilters", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
  });

  it("trims the query, uses router.replace, and preserves focus on the active control", async () => {
    const user = userEvent.setup();
    renderFilters("reviewer");

    const search = screen.getByLabelText("Search recordings");
    await user.type(search, "  Alpha  ");

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenLastCalledWith("/workspace?query=Alpha", { scroll: false });
    expect(search).toHaveFocus();
  });

  it("writes valid stage, source, sort, and admin assignment filters back to the URL", async () => {
    const user = userEvent.setup();
    renderFilters("admin", filters({ tab: "all" }));

    await user.selectOptions(screen.getByLabelText("Stage"), "pending_approval");
    await user.selectOptions(screen.getByLabelText("Source"), "record");
    await user.type(screen.getByLabelText("Assigned user ID"), "approver-1");
    await user.selectOptions(screen.getByLabelText("Sort"), "updated_desc");

    expect(mockReplace).toHaveBeenLastCalledWith(
      "/workspace?stage=pending_approval&source=record&assignmentUserId=approver-1&sort=updated_desc",
      { scroll: false },
    );
  });

  it("announces the current result count politely", () => {
    const { rerender } = renderFilters("reviewer", filters(), 1);

    const announcement = screen.getByRole("status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveTextContent("1 result");

    rerender(<WorkFilters filters={filters()} resultCount={3} role="reviewer" />);
    expect(screen.getByRole("status")).toHaveTextContent("3 results");
  });
});
