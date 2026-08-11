// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSegments, createCasefile } from "./test-fixtures";
import { RevisionHistory } from "./revision-history";

const { mockRecover } = vi.hoisted(() => ({
  mockRecover: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/server/actions/administration-actions", () => ({
  recoverRevisionAction: mockRecover,
}));

const archivedRevision = {
  id: "rev-0",
  version: 1,
  state: "superseded",
  stateLabel: "Superseded",
  summary: "Initial draft",
  createdAt: "2026-08-01T11:00:00.000Z",
  createdAtLabel: "01 Aug 2026, 11:00 UTC",
  createdAtIso: "2026-08-01T11:00:00.000Z",
  submittedAt: null,
  approvedAt: null,
  submittedByDisplay: null,
  segments: baseSegments.map((segment) =>
    segment.id === "seg-1" ? { ...segment, text: "Original wording." } : { ...segment },
  ),
};

function buildOverrides(accessKind: "admin_oversight" | "active_reviewer") {
  return {
    access: {
      kind: accessKind,
      recordingId: "rec-1",
      ...(accessKind === "active_reviewer" ? { assignmentId: "assign-1" } : {}),
      historical: false,
    },
    revisions: [
      {
        ...createCasefile().revisions[0],
        version: 2,
        segments: baseSegments,
      },
      archivedRevision,
    ],
  };
}

describe("RevisionHistory (demo-governance-bringback)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists the lineage with state, date, summary, and snapshot deep links", () => {
    render(<RevisionHistory casefile={createCasefile(buildOverrides("active_reviewer"))} />);

    expect(screen.getByText("v2")).toBeVisible();
    expect(screen.getByText("v1")).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.getByText("Superseded")).toBeVisible();

    const activeLink = screen.getByRole("link", { name: "View (active)" });
    expect(activeLink).toHaveAttribute(
      "href",
      "/recordings/rec-1?revision=rev-1",
    );
    const snapshotLink = screen.getByRole("link", { name: "View snapshot" });
    expect(snapshotLink).toHaveAttribute(
      "href",
      "/recordings/rec-1?revision=rev-0",
    );
  });

  it("labels the viewed snapshot as 'Currently viewed' (not 'Active') on a historical deep link", async () => {
    // Regression: on ?revision=<archived id> the read model swaps
    // casefile.revision to the VIEWED revision; the drawer must still label
    // 'Active' by the live activeRevisionId and diff 'vs active' against the
    // live active revision's segments, not the viewed snapshot's.
    const user = userEvent.setup();
    const casefile = createCasefile(buildOverrides("admin_oversight"));
    casefile.activeRevisionId = "rev-1";
    casefile.revision = casefile.revisions[1]; // viewed snapshot = archived v1
    render(<RevisionHistory casefile={casefile} />);

    const rows = screen.getAllByRole("listitem");
    const activeRow = rows.find((row) => row.textContent?.includes("v2"))!;
    const viewedRow = rows.find((row) => row.textContent?.includes("v1"))!;

    expect(
      activeRow.querySelector('[data-tone="success"]'),
    ).toHaveTextContent("Active");
    expect(viewedRow.querySelector('[data-tone="success"]')).toBeNull();
    expect(viewedRow).toHaveTextContent("Currently viewed");
    expect(viewedRow).toHaveTextContent("Superseded");

    // 'Diff vs active' on the viewed row still compares against the LIVE
    // active revision (v2 segments), not the viewed snapshot's own segments.
    await user.click(screen.getByTestId("diff-toggle-v1"));
    const diffRows = screen
      .getByRole("list", { name: "Diff of v1 against the active revision" })
      .querySelectorAll("li");
    expect(diffRows).toHaveLength(2);
    expect(diffRows[0]).toHaveAttribute("data-marker", "changed");
    expect(diffRows[1]).toHaveAttribute("data-marker", "same");
  });

  it("diffs an archived revision against the active one inline", async () => {
    const user = userEvent.setup();
    render(<RevisionHistory casefile={createCasefile(buildOverrides("active_reviewer"))} />);

    await user.click(screen.getByTestId("diff-toggle-v1"));

    const rows = screen
      .getByRole("list", { name: "Diff of v1 against the active revision" })
      .querySelectorAll("li");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-marker", "changed");
    expect(rows[0]).toHaveTextContent("Original wording.");
    expect(rows[0]).toHaveTextContent("Hello world.");
    expect(rows[1]).toHaveAttribute("data-marker", "same");

    await user.click(screen.getByTestId("diff-toggle-v1"));
    expect(
      screen.queryByRole("list", { name: "Diff of v1 against the active revision" }),
    ).toBeNull();
  });

  it("hides the recovery control from non-admin access", () => {
    render(<RevisionHistory casefile={createCasefile(buildOverrides("active_reviewer"))} />);

    expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
  });

  it("lets admin oversight recover an archived revision through the server action", async () => {
    const user = userEvent.setup();
    const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    mockRecover.mockResolvedValueOnce({
      ok: true,
      data: { href: "/recordings/rec-1", userId: "user-admin" },
      notice: "Recovered archived content into active draft v3; history kept.",
    });
    render(<RevisionHistory casefile={createCasefile(buildOverrides("admin_oversight"))} />);

    await user.click(screen.getByTestId("recover-v1"));

    expect(
      await screen.findByRole("dialog", { name: "Recover revision" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Recover v1 as active draft" }));

    expect(mockRecover).toHaveBeenCalledWith({
      recordingId: "rec-1",
      sourceRevisionId: "rev-0",
    });
    // Hard navigation (not router.push inside the async transition - that
    // races the casefile's RSC refresh and wedges on the client).
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/recordings/rec-1?notice=Recovered+archived+content+into+active+draft+v3%3B+history+kept.",
      ),
    );
    if (locationDescriptor) {
      Object.defineProperty(window, "location", locationDescriptor);
    }
  });

  it("keeps the modal open and shows the server error on a failing recovery", async () => {
    const user = userEvent.setup();
    mockRecover.mockResolvedValueOnce({
      ok: false,
      code: "STATE_CHANGED",
      message: "That revision is already the active one.",
    });
    render(<RevisionHistory casefile={createCasefile(buildOverrides("admin_oversight"))} />);

    await user.click(screen.getByTestId("recover-v1"));
    await user.click(
      await screen.findByRole("button", { name: "Recover v1 as active draft" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Recover revision" });
    expect(
      await within(dialog).findByRole("alert"),
    ).toHaveTextContent("That revision is already the active one.");
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });
});
