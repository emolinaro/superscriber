// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCasefileMock, requireActivePrincipalMock } = vi.hoisted(() => ({
  getCasefileMock: vi.fn(),
  requireActivePrincipalMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/server/session", () => ({
  requireActivePrincipal: requireActivePrincipalMock,
}));

vi.mock("@/server/casefile/read-model", () => ({
  getCasefile: getCasefileMock,
}));

vi.mock("@/components/casefile/casefile-workspace", () => ({
  CasefileWorkspace: ({ pageNotice }: { pageNotice?: string | null }) => (
    <div>{pageNotice ?? "Casefile workspace"}</div>
  ),
}));

import RecordingPage from "./page";

const principal = {
  userId: "admin-1",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
} as const;

describe("RecordingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireActivePrincipalMock.mockResolvedValue(principal);
    getCasefileMock.mockReturnValue({ recordingId: "rec-1" });
  });

  afterEach(() => {
    cleanup();
  });

  it("passes the first notice query value to the casefile notice boundary", async () => {
    const page = await RecordingPage({
      params: Promise.resolve({ recordingId: "rec-1" }),
      searchParams: Promise.resolve({
        notice: ["Recovered archived content into active draft v3; history kept.", "ignored"],
      }),
    });
    render(page);

    expect(
      screen.getByText("Recovered archived content into active draft v3; history kept."),
    ).toBeVisible();
  });
});
