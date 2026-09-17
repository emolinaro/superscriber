import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  change: vi.fn(),
  create: vi.fn(),
  completePasswordChange: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("@/server/session", () => ({
  getActiveSession: mocks.session,
  getActivePrincipal: vi.fn(),
}));
vi.mock("@/server/administration/account-lifecycle-service", () => ({
  changeAccountLifecycle: mocks.change,
  createAccountWithTemporaryPassword: mocks.create,
}));
vi.mock("@/server/auth/account-lifecycle", () => ({
  completeMandatoryPasswordChange: mocks.completePasswordChange,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { completeMandatoryPasswordChangeAction } from "./account-lifecycle-actions";
import {
  changeAccountLifecycleAction,
  createTemporaryAccountAction,
} from "./administration-actions";
const input = {
  action: "deactivate" as const,
  userId: "target",
  expectedIsActive: true,
  reason: "Staff leave",
  expectedActorUserId: "admin",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({
    user: { userId: "admin" },
    authSessionId: "session-admin",
  });
});
it("requires an authenticated session and binds the rendered actor", async () => {
  mocks.session.mockResolvedValueOnce(null);
  expect(await changeAccountLifecycleAction(input)).toMatchObject({
    ok: false,
    code: "AUTH_EXPIRED",
  });
  expect(
    await changeAccountLifecycleAction({
      ...input,
      expectedActorUserId: "other",
    }),
  ).toMatchObject({ ok: false, code: "ACCESS_DENIED" });
  expect(mocks.change).not.toHaveBeenCalled();
});
it("passes durable actor identity to lifecycle authority checks", async () => {
  mocks.change.mockReturnValue({
    userId: "target",
    isActive: false,
    revokedSessionCount: 2,
  });
  expect(await changeAccountLifecycleAction(input)).toMatchObject({
    ok: true,
    data: { isActive: false },
  });
  expect(mocks.change).toHaveBeenCalledWith({
    actorUserId: "admin",
    actorAuthSessionId: "session-admin",
    input,
  });
});
it("changes a mandatory temporary password for the bound actor session", async () => {
  mocks.completePasswordChange.mockResolvedValue({ userId: "admin" });

  await expect(
    completeMandatoryPasswordChangeAction({
      expectedActorUserId: "other",
      password: "new-account-secret",
      confirmPassword: "new-account-secret",
    }),
  ).resolves.toMatchObject({ ok: false, code: "ACCESS_DENIED" });

  await expect(
    completeMandatoryPasswordChangeAction({
      expectedActorUserId: "admin",
      password: "new-account-secret",
      confirmPassword: "new-account-secret",
    }),
  ).resolves.toMatchObject({ ok: true, data: { userId: "admin" } });
  expect(mocks.completePasswordChange).toHaveBeenCalledWith({
    actorUserId: "admin",
    actorAuthSessionId: "session-admin",
    password: "new-account-secret",
    confirmPassword: "new-account-secret",
  });
});

it("preserves the one-shot credential result when cache revalidation fails", async () => {
  mocks.create.mockResolvedValue({
    user: { id: "target" },
    temporaryPassword: "test-only-secret",
  });
  mocks.revalidate.mockImplementation(() => {
    throw new Error("cache unavailable");
  });
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      await createTemporaryAccountAction({
        displayName: "New User",
        email: "new@example.com",
        role: "reviewer",
        reason: "New colleague",
        expectedActorUserId: "admin",
      }),
    ).toMatchObject({
      ok: true,
      data: { temporaryPassword: "test-only-secret" },
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("test-only-secret");
  } finally {
    spy.mockRestore();
  }
});
