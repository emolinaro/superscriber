// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CasefileWorkspace } from "./casefile-workspace";
import { createCasefile } from "./test-fixtures";

const phoneSafetyModeMock = vi.fn(() => false);
const routerRefreshMock = vi.fn();
const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
    push: routerPushMock,
  }),
}));

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => phoneSafetyModeMock(),
}));

vi.mock("@/components/auth/session-recovery-dialog", () => ({
  SessionRecoveryDialog: ({ open, onRecovered }: { open: boolean; onRecovered: () => void }) =>
    open ? <button onClick={onRecovered}>Recover session</button> : null,
}));

vi.mock("@/components/orchestration-status-poller", () => ({
  OrchestrationStatusPoller: () => null,
}));

describe("CasefileWorkspace session recovery integration", () => {
  beforeEach(() => {
    phoneSafetyModeMock.mockReturnValue(false);
    routerRefreshMock.mockReset();
    routerPushMock.mockReset();
  });

  it("opens recovery without retrying a deliberate decision and preserves the entered reason", async () => {
    const user = userEvent.setup();
    const withdrawAction = vi.fn().mockResolvedValue({
      ok: false,
      code: "AUTH_EXPIRED",
      message: "Session expired. Sign in again to continue.",
    });

    render(
      <CasefileWorkspace
        approveAction={vi.fn()}
        renameSpeakerAction={vi.fn()}
        enterAdminActionModeAction={vi.fn()}
        exitAdminActionModeAction={vi.fn()}
        initialCasefile={createCasefile({
          stage: "pending_approval",
          stageLabel: "Pending approval",
          revision: {
            ...createCasefile().revision,
            state: "pending_approval",
            stateLabel: "Pending approval",
            submittedAt: "2026-08-01T12:10:00.000Z",
            submittedByDisplay: "Reviewer Example",
          },
          capabilities: {
            ...createCasefile().capabilities,
            canEdit: false,
            canSave: false,
            canSubmit: false,
            canWithdraw: true,
            denials: {
              ...createCasefile().capabilities.denials,
              canEdit: "wrong_revision_state",
              canSave: "wrong_revision_state",
              canSubmit: "wrong_revision_state",
              canWithdraw: null,
            },
          },
          nextActions: [{ capability: "canWithdraw", label: "Withdraw submission" }],
        })}
        reopenAction={vi.fn()}
        requestChangesAction={vi.fn()}
        saveAction={vi.fn()}
        submitAction={vi.fn()}
        withdrawAction={withdrawAction}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Withdraw revision" }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Need to restore the editable draft." },
    });
    await user.click(screen.getAllByRole("button", { name: "Withdraw revision" })[1]);

    expect(await screen.findByRole("button", { name: "Recover session" })).toBeVisible();
    expect(withdrawAction).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Recover session" }));

    expect(withdrawAction).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Reason")).toHaveValue("Need to restore the editable draft.");
  });
});
