import { describe, expect, it, vi } from "vitest";

const { redirectMock, getActiveSessionMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
  getActiveSessionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/server/session", () => ({
  getActiveSession: getActiveSessionMock,
  resolveAuthorizedReturnTo: vi.fn(() => "/workspace"),
}));

import LandingPage from "./page";

describe("LandingPage authenticated routing", () => {
  it("routes a temporary-password sign-in to mandatory password change", async () => {
    getActiveSessionMock.mockResolvedValue({
      user: {
        userId: "user-temp",
        email: "temp@example.com",
        displayName: "Temp User",
        role: "reviewer",
      },
      expiresAt: "2099-01-01T00:00:00.000Z",
      authSessionId: "session-temp",
      mustChangePassword: true,
    });

    await expect(
      LandingPage({ searchParams: Promise.resolve({ returnTo: "/workspace" }) }),
    ).rejects.toThrow("REDIRECT:/account/password-change?returnTo=%2Fworkspace");
  });
});
