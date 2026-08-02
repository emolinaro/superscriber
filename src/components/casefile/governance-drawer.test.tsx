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
