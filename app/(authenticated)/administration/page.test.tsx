// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  redirectMock,
  requireActivePrincipalMock,
  listAdministrationMock,
} = vi.hoisted(() => ({
  redirectMock: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
  requireActivePrincipalMock: vi.fn(),
  listAdministrationMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/server/session", () => ({
  requireActivePrincipal: requireActivePrincipalMock,
}));

vi.mock("@/server/administration/service", () => ({
  listAdministration: listAdministrationMock,
}));

vi.mock("@/components/admin/administration-shell", () => ({
  AdministrationShell: ({ section }: { section: string }) => <div>Selected section: {section}</div>,
}));

import AdministrationPage from "./page";

const adminPrincipal = {
  userId: "admin-1",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
} as const;

const reviewerPrincipal = {
  userId: "reviewer-1",
  email: "reviewer@example.com",
  displayName: "Reviewer",
  role: "reviewer",
} as const;

describe("AdministrationPage", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    requireActivePrincipalMock.mockResolvedValue(adminPrincipal);
    listAdministrationMock.mockImplementation((_principal, filters) => ({
      section: filters.section,
    }));
  });

  it("defaults to Accounts and normalizes unknown sections", async () => {
    const defaultPage = await AdministrationPage({
      searchParams: Promise.resolve({ query: "  reviewer  " }),
    });
    render(defaultPage);

    expect(requireActivePrincipalMock).toHaveBeenCalledWith("/administration");
    expect(listAdministrationMock).toHaveBeenCalledWith(adminPrincipal, {
      section: "accounts",
      query: "reviewer",
    });
    expect(screen.getByText("Selected section: accounts")).toBeVisible();

    const unknownPage = await AdministrationPage({
      searchParams: Promise.resolve({ section: "legacy", query: "  approver  " }),
    });
    render(unknownPage);

    expect(listAdministrationMock).toHaveBeenLastCalledWith(adminPrincipal, {
      section: "accounts",
      query: "approver",
    });
    expect(screen.getAllByText("Selected section: accounts")).toHaveLength(2);
  });

  it("passes through valid assignment and policy filters", async () => {
    const assignmentsPage = await AdministrationPage({
      searchParams: Promise.resolve({
        section: ["assignments", "accounts"],
        status: "history",
        recordingId: "rec-1",
        userId: "user-1",
        role: "reviewer",
        from: "2026-08-01T12:00:00.000Z",
        to: "2026-08-02T12:00:00.000Z",
      }),
    });
    render(assignmentsPage);

    expect(listAdministrationMock).toHaveBeenCalledWith(adminPrincipal, {
      section: "assignments",
      status: "history",
      recordingId: "rec-1",
      userId: "user-1",
      role: "reviewer",
      from: "2026-08-01T12:00:00.000Z",
      to: "2026-08-02T12:00:00.000Z",
    });
    expect(screen.getByText("Selected section: assignments")).toBeVisible();

    const policyPage = await AdministrationPage({
      searchParams: Promise.resolve({ section: "policy" }),
    });
    render(policyPage);

    expect(listAdministrationMock).toHaveBeenLastCalledWith(adminPrincipal, {
      section: "policy",
    });
    expect(screen.getByText("Selected section: policy")).toBeVisible();
  });

  it("redirects non-admin accounts back to workspace", async () => {
    requireActivePrincipalMock.mockResolvedValue(reviewerPrincipal);

    await expect(
      AdministrationPage({
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(
      "REDIRECT:/workspace?error=Only%20admin%20accounts%20can%20open%20administration.",
    );
  });
});
