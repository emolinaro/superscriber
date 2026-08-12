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
  }: {
    actionModeEntryOptions?: Array<{ effectiveRole: "reviewer" | "approver" }>;
  } = {}) {
    let state: { open: boolean; setOpen: (value: boolean) => void } | null = null;
    function Host() {
      const [open, setOpen] = useState(false);
      state = { open, setOpen };
      return (
        <GovernanceDrawer
          actionModeEntryOptions={actionModeEntryOptions}
          actionModeSessionId={null}
          casefile={createCasefile()}
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
    await user.click(screen.getByRole("button", { name: "Enter approver action mode" }));

    expect(screen.getByRole("dialog", { name: "Governance" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Enter admin action mode" })).toBeVisible();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Enter admin action mode" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Governance" })).toBeVisible();
  });
});
