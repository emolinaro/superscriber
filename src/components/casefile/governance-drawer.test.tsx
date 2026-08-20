// @vitest-environment jsdom

import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCasefile } from "./test-fixtures";
import { GovernanceDrawer } from "./governance-drawer";

// The Revisions tab now hosts the recovery control; the drawer tests do not
// exercise it, but RevisionHistory requires the router hook.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

describe("GovernanceDrawer", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  beforeEach(() => {
    setViewport(1280);
  });

  // demo-gov-placement: the trigger is header-hosted now - tests drive the
  // component's controlled open prop through a tiny state host.
  function harness({
    actionModeEntryOptions = [],
    casefile = createCasefile(),
  }: {
    actionModeEntryOptions?: Array<{ effectiveRole: "reviewer" | "approver" }>;
    casefile?: ReturnType<typeof createCasefile>;
  } = {}) {
    let state: { open: boolean; setOpen: (value: boolean) => void } | null = null;
    function Host() {
      const [open, setOpen] = useState(false);
      state = { open, setOpen };
      return (
        <GovernanceDrawer
          actionModeEntryOptions={actionModeEntryOptions}
          actionModeSessionId={null}
          casefile={casefile}
          onEnterActionMode={vi.fn()}
          open={open}
          onToggle={() => setOpen((current) => !current)}
        />
      );
    }
    return { Host, getState: () => state! };
  }

  it("stays unmounted by default on desktop and renders the exact governance tabs once opened", () => {
    const { Host, getState } = harness();
    render(<Host />);

    // No rail trigger anymore; the casefile header owns "Governance >".
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: /governance$/i })).toBeNull();

    act(() => getState().setOpen(true));

    for (const name of ["Policy", "Provenance", "Assignments", "Revisions", "Decisions", "Audit"]) {
      expect(screen.getByRole("tab", { name })).toBeVisible();
    }
    expect(screen.getByRole("complementary", { name: "Governance" })).toBeVisible();
  });

  it("renders a changes-requested decision row with the full note, revision version, and timestamp", async () => {
    const user = userEvent.setup();
    // Deliberately long, multi-line note: the sacred partition rule demands
    // legible rendering with no clamping or truncation.
    const longNote =
      "Segment 12 names the wrong defendant.\nVerify every speaker label against the docket before resubmitting. " +
      "follow-up ".repeat(80);
    const base = createCasefile();
    const { Host, getState } = harness({
      casefile: createCasefile({
        revisions: [
          { ...base.revisions[0], id: "rev-1", version: 1, state: "draft", stateLabel: "Draft" },
          {
            ...base.revisions[0],
            id: "rev-2",
            version: 2,
            state: "changes_requested",
            stateLabel: "Changes requested",
          },
        ],
        decisions: [
          {
            id: "decision-1",
            revisionId: "rev-2",
            state: "changes_requested",
            label: "Changes requested",
            actorRole: "approver",
            effectiveRole: "approver",
            actorDisplay: "Approver Example",
            note: longNote,
            createdAt: "2026-08-02T09:30:00.000Z",
            createdAtLabel: "02 Aug 2026, 09:30 UTC",
            createdAtIso: "2026-08-02T09:30:00.000Z",
          },
        ],
      }),
    });
    render(<Host />);

    act(() => getState().setOpen(true));
    await user.click(screen.getByRole("tab", { name: "Decisions" }));

    const rows = document.querySelectorAll(".governance-decision");
    expect(rows).toHaveLength(1);
    const rowText = rows[0].textContent ?? "";
    expect(rowText).toContain("Changes requested");
    expect(rowText).toContain(longNote);
    expect(rowText).toContain("v2");
    expect(rowText).toContain("Approver Example");
    expect(rowText).toContain("02 Aug 2026, 09:30 UTC");
  });

  it("renders one governance decision row per changes-requested incident", async () => {
    const user = userEvent.setup();
    const base = createCasefile();
    const { Host, getState } = harness({
      casefile: createCasefile({
        revisions: [
          {
            ...base.revisions[0],
            id: "rev-1",
            version: 1,
            state: "changes_requested",
            stateLabel: "Changes requested",
          },
          {
            ...base.revisions[0],
            id: "rev-2",
            version: 2,
            state: "changes_requested",
            stateLabel: "Changes requested",
          },
        ],
        decisions: [
          {
            id: "decision-2",
            revisionId: "rev-2",
            state: "changes_requested",
            label: "Changes requested",
            actorRole: "approver",
            effectiveRole: "approver",
            actorDisplay: "Approver Two",
            note: "Second incident note.",
            createdAt: "2026-08-03T10:00:00.000Z",
            createdAtLabel: "03 Aug 2026, 10:00 UTC",
            createdAtIso: "2026-08-03T10:00:00.000Z",
          },
          {
            id: "decision-1",
            revisionId: "rev-1",
            state: "changes_requested",
            label: "Changes requested",
            actorRole: "approver",
            effectiveRole: "approver",
            actorDisplay: "Approver One",
            note: "First incident note.",
            createdAt: "2026-08-01T08:00:00.000Z",
            createdAtLabel: "01 Aug 2026, 08:00 UTC",
            createdAtIso: "2026-08-01T08:00:00.000Z",
          },
        ],
      }),
    });
    render(<Host />);

    act(() => getState().setOpen(true));
    await user.click(screen.getByRole("tab", { name: "Decisions" }));

    const rows = document.querySelectorAll(".governance-decision");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Second incident note.");
    expect(rows[0].textContent).toContain("v2");
    expect(rows[0].textContent).toContain("03 Aug 2026, 10:00 UTC");
    expect(rows[1].textContent).toContain("First incident note.");
    expect(rows[1].textContent).toContain("v1");
    expect(rows[1].textContent).toContain("01 Aug 2026, 08:00 UTC");
  });

  it("wires governance tabs and the active panel with accessible ids and roving tabIndex", async () => {
    const user = userEvent.setup();
    const { Host, getState } = harness();
    render(<Host />);

    act(() => getState().setOpen(true));

    const tabs = ["Policy", "Provenance", "Assignments", "Revisions", "Decisions", "Audit"].map(
      (name) => screen.getByRole("tab", { name }),
    );
    const policyTab = tabs[0];
    const panel = screen.getByRole("tabpanel");
    const tabIds = tabs.map((tab) => tab.getAttribute("id"));

    expect(new Set(tabIds).size).toBe(tabs.length);
    expect(policyTab).toHaveAttribute("aria-selected", "true");
    expect(policyTab).toHaveAttribute("tabIndex", "0");
    expect(policyTab).toHaveAttribute("aria-controls");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("tabIndex", "-1");
    expect(panel).toHaveAttribute("id", policyTab.getAttribute("aria-controls"));
    expect(panel).toHaveAttribute("aria-labelledby", policyTab.getAttribute("id"));
  });

  it("moves focus and activates governance tabs with arrow, home, and end keys", async () => {
    const user = userEvent.setup();
    const { Host, getState } = harness();
    render(<Host />);

    act(() => getState().setOpen(true));

    const policyTab = screen.getByRole("tab", { name: "Policy" });
    await user.click(policyTab);
    await user.keyboard("{ArrowRight}");

    const provenanceTab = screen.getByRole("tab", { name: "Provenance" });
    expect(provenanceTab).toHaveFocus();
    expect(provenanceTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      provenanceTab.getAttribute("id"),
    );

    await user.keyboard("{End}");

    const auditTab = screen.getByRole("tab", { name: "Audit" });
    expect(auditTab).toHaveFocus();
    expect(auditTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(policyTab).toHaveFocus();
    expect(policyTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowLeft}");
    expect(auditTab).toHaveFocus();
    expect(auditTab).toHaveAttribute("aria-selected", "true");
  });

  it("renders phone governance as accordions", () => {
    setViewport(390);
    const { Host } = harness();
    render(<Host />);

    for (const name of ["Policy", "Provenance", "Assignments", "Revisions", "Decisions", "Audit"]) {
      expect(screen.getByText(name)).toBeVisible();
    }
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("locks the background and restores focus to the header trigger for the tablet governance drawer", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);
    setViewport(960);

    const trigger = document.createElement("button");
    trigger.textContent = "Governance >";
    document.body.prepend(trigger);
    trigger.focus();

    const { Host, getState } = harness();
    render(<Host />, { container: appRoot });

    // The header link (trigger) holds focus before opening; the drawer must
    // restore focus to it on close (in the real layout via the header).
    act(() => getState().setOpen(true));

    expect(screen.getByRole("dialog", { name: "Governance" })).toBeVisible();
    expect(document.querySelector("#app-root")).toHaveAttribute("inert");
    expect(document.body).toHaveStyle({ overflow: "hidden" });

    await user.click(screen.getByRole("button", { name: "Close governance" }));

    await waitFor(() => {
      expect(document.querySelector("#app-root")).not.toHaveAttribute("inert");
    });
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });

  it("closes only action-mode entry on Escape when Governance remains open", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);
    setViewport(960);
    const { Host, getState } = harness({
      actionModeEntryOptions: [{ effectiveRole: "approver" }],
    });
    render(<Host />, { container: appRoot });

    act(() => getState().setOpen(true));
    const governanceDialog = screen.getByRole("dialog", { name: "Governance" });
    await user.click(screen.getByRole("button", { name: "Enter approver action mode" }));

    const actionModeDialog = screen.getByRole("dialog", { name: "Enter admin action mode" });
    const governanceBackdrop = governanceDialog.closest(".modal-backdrop") as HTMLElement;
    const actionModeBackdrop = actionModeDialog.closest(".modal-backdrop") as HTMLElement;

    expect(Number(actionModeBackdrop.style.zIndex)).toBeGreaterThan(
      Number(governanceBackdrop.style.zIndex),
    );
    expect(governanceBackdrop).toHaveAttribute("inert");
    expect(governanceBackdrop).toHaveAttribute("aria-hidden", "true");
    expect(actionModeBackdrop).not.toHaveAttribute("inert");
    expect(actionModeBackdrop).not.toHaveAttribute("aria-hidden");
    expect(screen.queryByRole("dialog", { name: "Governance" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Enter admin action mode" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Governance" })).toBeVisible();
  });
});
