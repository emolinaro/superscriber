// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCasefile } from "./test-fixtures";
import { GovernanceDrawer } from "./governance-drawer";

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

  it("renders the exact governance tabs and stays collapsed by default on desktop", async () => {
    const user = userEvent.setup();
    render(<GovernanceDrawer casefile={createCasefile()} />);

    expect(screen.getByRole("button", { name: "Open governance" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "Open governance" }));

    for (const name of ["Policy", "Provenance", "Assignments", "Revisions", "Decisions", "Audit"]) {
      expect(screen.getByRole("tab", { name })).toBeVisible();
    }
  });

  it("wires governance tabs and the active panel with accessible ids and roving tabIndex", async () => {
    const user = userEvent.setup();
    render(<GovernanceDrawer casefile={createCasefile()} />);

    await user.click(screen.getByRole("button", { name: "Open governance" }));

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
    render(<GovernanceDrawer casefile={createCasefile()} />);

    await user.click(screen.getByRole("button", { name: "Open governance" }));

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
    render(<GovernanceDrawer casefile={createCasefile()} />);

    for (const name of ["Policy", "Provenance", "Assignments", "Revisions", "Decisions", "Audit"]) {
      expect(screen.getByText(name)).toBeVisible();
    }
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("locks the background and restores focus for the tablet governance drawer", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);
    setViewport(960);

    render(<GovernanceDrawer casefile={createCasefile()} />, { container: appRoot });

    await user.click(screen.getByRole("button", { name: "Open governance" }));

    expect(screen.getByRole("dialog", { name: "Governance" })).toBeVisible();
    expect(document.querySelector("#app-root")).toHaveAttribute("inert");
    expect(document.body).toHaveStyle({ overflow: "hidden" });

    await user.click(screen.getByRole("button", { name: "Close governance" }));

    expect(screen.getByRole("button", { name: "Open governance" })).toHaveFocus();
    expect(document.querySelector("#app-root")).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("");
  });
});
