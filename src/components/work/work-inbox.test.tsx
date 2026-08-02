// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserRole } from "@/domain/models";
import type { WorkInboxRow, WorkInboxViewModel } from "@/server/work-inbox/service";
import { WorkInbox } from "./work-inbox";

const { mockReplace } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const reviewerRow: WorkInboxRow = {
  recordingId: "REC-SEARCH",
  title: "Alpha dictation",
  stage: "draft_review",
  stageLabel: "Draft review",
  source: "upload",
  sourceLabel: "Upload",
  revisionLabel: "Draft",
  progressLabel: "Draft review",
  assignmentLabel: "Assigned to you",
  updatedAt: "2026-08-01T12:03:00.000Z",
  updatedAtLabel: "01 Aug 2026, 12:03 UTC",
  updatedAtIso: "2026-08-01T12:03:00.000Z",
  href: "/recordings/REC-SEARCH",
  actionable: true,
  actionLabel: "Open draft",
  tabId: "to-review",
  assignmentUserIds: ["reviewer-1"],
};

const completedReviewerRow: WorkInboxRow = {
  ...reviewerRow,
  recordingId: "rec-approved",
  title: "Completed reviewer item",
  stage: "approved",
  stageLabel: "Approved",
  revisionLabel: "Approved",
  progressLabel: "Approved",
  assignmentLabel: "Completed snapshot",
  updatedAt: "2026-08-01T12:01:00.000Z",
  updatedAtLabel: "01 Aug 2026, 12:01 UTC",
  updatedAtIso: "2026-08-01T12:01:00.000Z",
  href: "/recordings/rec-approved?revision=rev-approved",
  actionable: false,
  actionLabel: "View snapshot",
  tabId: "completed",
};

const ROLE_EMPTY_COPY: Record<UserRole, string> = {
  uploader: "No uploads yet.",
  reviewer: "No transcript review is assigned to you.",
  approver: "No approval decision is waiting for you.",
  admin: "No recordings match these filters.",
};

const ROLE_TABS: Record<UserRole, Array<{ id: string; label: string; count: number }>> = {
  uploader: [
    { id: "my-uploads", label: "My uploads", count: 0 },
    { id: "needs-attention", label: "Needs attention", count: 1 },
    { id: "processing", label: "Processing", count: 2 },
    { id: "ready", label: "Ready", count: 3 },
  ],
  reviewer: [
    { id: "to-review", label: "To review", count: 1 },
    { id: "waiting", label: "Waiting", count: 2 },
    { id: "completed", label: "Completed", count: 3 },
  ],
  approver: [
    { id: "to-decide", label: "To decide", count: 1 },
    { id: "waiting", label: "Waiting", count: 2 },
    { id: "completed", label: "Completed", count: 3 },
  ],
  admin: [
    { id: "all", label: "All", count: 1 },
    { id: "needs-attention", label: "Needs attention", count: 2 },
    { id: "review", label: "Review", count: 3 },
    { id: "approval", label: "Approval", count: 4 },
    { id: "approved", label: "Approved", count: 5 },
  ],
};

const ROLE_COPY: Record<UserRole, Pick<WorkInboxViewModel, "heading" | "responsibility">> = {
  uploader: {
    heading: "Your uploads",
    responsibility: "Start recordings and track each upload through processing.",
  },
  reviewer: {
    heading: "Transcript review",
    responsibility: "Review assigned drafts and submit accurate revisions for approval.",
  },
  approver: {
    heading: "Approval decisions",
    responsibility:
      "Decide submitted revisions and reopen approved casefiles when governance requires it.",
  },
  admin: {
    heading: "Recording oversight",
    responsibility: "Monitor recordings and route governed work without acting implicitly.",
  },
};

function createInbox(role: UserRole, overrides: Partial<WorkInboxViewModel> = {}): WorkInboxViewModel {
  const defaultTab = ROLE_TABS[role][0]!.id;

  return {
    role,
    ...ROLE_COPY[role],
    filters: {
      tab: defaultTab,
      query: "",
      stage: null,
      source: null,
      assignmentUserId: null,
      sort: "default",
    },
    tabs: ROLE_TABS[role].map((tab, index) => ({
      ...tab,
      href: index === 0 ? "/workspace" : `/workspace?tab=${tab.id}`,
      isActive: tab.id === defaultTab,
    })),
    rows: [reviewerRow],
    nextAction: reviewerRow,
    ...overrides,
  };
}

describe("WorkInbox", () => {
  it("omits the next action when the server returns null", () => {
    render(
      <WorkInbox
        model={{
          ...createInbox("reviewer"),
          rows: [],
          nextAction: null,
        }}
      />,
    );

    expect(screen.queryByText("Next action")).not.toBeInTheDocument();
    expect(screen.getByText("No transcript review is assigned to you.")).toBeVisible();
  });

  it("renders next-action details without inventing an action control", () => {
    render(
      <WorkInbox
        model={{
          ...createInbox("reviewer"),
          nextAction: {
            ...reviewerRow,
            actionLabel: null,
          },
        }}
      />,
    );

    const nextAction = screen.getByRole("region", { name: "Next action" });
    expect(within(nextAction).getByText("Alpha dictation")).toBeVisible();
    expect(within(nextAction).queryByRole("link")).not.toBeInTheDocument();
  });

  it.each(["uploader", "reviewer", "approver", "admin"] as const)(
    "renders exact role heading, responsibility, tabs, counts, and empty copy for %s",
    (role) => {
      render(
        <WorkInbox
          model={{
            ...createInbox(role),
            rows: [],
            nextAction: null,
          }}
        />,
      );

      const inbox = createInbox(role, { rows: [], nextAction: null });
      expect(screen.getByRole("heading", { name: inbox.heading })).toBeVisible();
      expect(screen.getByText(inbox.responsibility)).toBeVisible();
      expect(screen.getByText(ROLE_EMPTY_COPY[role])).toBeVisible();

      const nav = screen.getByRole("navigation", { name: "Work status" });
      for (const tab of inbox.tabs) {
        const link = within(nav).getByRole("link", { name: new RegExp(`${tab.label}\\s+${tab.count}`) });
        expect(link).toHaveAttribute("href", tab.href);
      }

      const current = within(nav).getByRole("link", {
        current: "page",
        name: new RegExp(`^${inbox.tabs[0]!.label}`),
      });
      expect(current).toHaveAttribute("href", inbox.tabs[0]!.href);
    },
  );

  it("renders a next-action strip directly from the server row", () => {
    render(<WorkInbox model={createInbox("reviewer")} />);

    const nextAction = screen.getByRole("region", { name: "Next action" });
    expect(within(nextAction).getByText("Alpha dictation")).toBeVisible();
    expect(within(nextAction).getByText("Draft review")).toBeVisible();

    const action = within(nextAction).getByRole("link", { name: "Alpha dictation" });
    expect(action).toHaveAttribute("href", "/recordings/REC-SEARCH");
    expect(action).toHaveTextContent("Open draft");
  });

  it("renders completed snapshot rows without promoting them into next action", () => {
    render(
      <WorkInbox
        model={createInbox("reviewer", {
          rows: [completedReviewerRow],
          nextAction: null,
        })}
      />,
    );

    expect(screen.queryByRole("region", { name: "Next action" })).not.toBeInTheDocument();
    const action = screen.getByRole("link", { name: "Completed reviewer item" });
    expect(action).toHaveAttribute("href", "/recordings/rec-approved?revision=rev-approved");
    expect(action).toHaveTextContent("View snapshot");
  });
});
