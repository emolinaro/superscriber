// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal, UserRole } from "@/domain/models";
import { AppShell } from "./app-shell";

const mockUsePathname = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

const ROLE_NAV: Record<UserRole, string[]> = {
  uploader: ["/workspace", "/ingest"],
  reviewer: ["/workspace"],
  approver: ["/workspace"],
  admin: ["/workspace", "/ingest", "/administration"],
};

function principal(role: UserRole): Principal {
  return {
    userId: `${role}-1`,
    displayName: "Alex Example",
    email: "alex@example.com",
    role,
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("AppShell", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/workspace");
  });

  it.each(Object.entries(ROLE_NAV))("renders exact role navigation for %s", (role, hrefs) => {
    render(
      <AppShell principal={principal(role as UserRole)}>
        <div>Workspace body</div>
      </AppShell>,
    );

    const links = within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole(
      "link",
    );

    expect(links.map((link) => link.getAttribute("href"))).toEqual(hrefs);
    expect(links.every((link) => link.classList.contains("interactive-target"))).toBe(true);
  });

  it("renders a skip link, 44 px target class hooks, and account details", async () => {
    const user = userEvent.setup();

    render(
      <AppShell principal={principal("admin")}>
        <div>Workspace body</div>
      </AppShell>,
    );

    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    expect(skipLink).toHaveAttribute("href", "#app-main");
    expect(skipLink).toHaveClass("interactive-target");

    const accountButton = screen.getByRole("button", { name: "Open account menu" });
    expect(accountButton).toHaveClass("interactive-target");

    await user.click(accountButton);

    expect(screen.getByText("Alex Example")).toBeVisible();
    expect(screen.getByText("alex@example.com")).toBeVisible();
    expect(screen.getByText("Admin")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign out" })).toHaveClass("interactive-target");
  });
});
