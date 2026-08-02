// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCasefile } from "./test-fixtures";
import { CasefileWorkspace } from "./casefile-workspace";

const phoneSafetyModeMock = vi.fn(() => false);
const pollerMock = vi.fn<(props: unknown) => null>(() => null);

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => phoneSafetyModeMock(),
}));

vi.mock("@/components/auth/session-recovery-dialog", () => ({
  SessionRecoveryDialog: ({ open }: { open: boolean }) =>
    open ? <div>Recover session</div> : null,
}));

vi.mock("@/components/orchestration-status-poller", () => ({
  OrchestrationStatusPoller: (props: unknown) => {
    pollerMock(props);
    return null;
  },
}));

function renderWorkspace(overrides: Record<string, unknown> = {}) {
  const saveAction = vi.fn();
  const submitAction = vi.fn();
  render(
    <CasefileWorkspace
      initialCasefile={createCasefile(overrides)}
      saveAction={saveAction}
      submitAction={submitAction}
    />,
  );

  return { saveAction, submitAction };
}

describe("CasefileWorkspace", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    phoneSafetyModeMock.mockReturnValue(false);
    pollerMock.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["draft_review", true],
    ["pending_approval", false],
    ["approved", false],
  ])("renders transcript fields only for editable %s", (stage, editable) => {
    renderWorkspace({
      stage,
      stageLabel: stage,
      revision: {
        ...createCasefile().revision,
        state:
          stage === "pending_approval"
            ? "pending_approval"
            : stage === "approved"
              ? "approved"
              : "draft",
        stateLabel: stage,
      },
      capabilities: {
        ...createCasefile().capabilities,
        canEdit: editable,
        canSave: editable,
        canSubmit: editable,
      },
    });

    expect(screen.queryAllByRole("textbox").length > 0).toBe(editable);
  });

  it("renders uploader status-only facts without transcript editing", () => {
    renderWorkspace({
      statusOnly: true,
      access: { kind: "uploader_status", recordingId: "rec-1", historical: false },
      revision: null,
      revisions: [],
      decisions: [],
      audit: [],
      media: { kind: "audio", url: null, denialReason: null },
      processing: {
        active: true,
        integrityState: "verified",
        transcriptJobState: "running",
        progressPercent: 42,
        etaSeconds: 18,
        verificationSummary: "Verifying upload.",
        recoveryHint: "Keep this tab open while transcript preparation finishes.",
      },
    });

    expect(screen.getByText("42% complete")).toBeVisible();
    expect(screen.getByText("Keep this tab open while transcript preparation finishes.")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows case header facts, summary, active row, confidence text, and no blank disabled editor", () => {
    renderWorkspace({
      assignmentLabel: "Assigned reviewer",
      historicalLabel: "Historical snapshot",
      stageLabel: "Pending approval",
      revision: {
        ...createCasefile().revision,
        state: "pending_approval",
        stateLabel: "Pending approval",
      },
      capabilities: {
        ...createCasefile().capabilities,
        canEdit: false,
        canSave: false,
        canSubmit: false,
      },
    });

    expect(screen.getByRole("heading", { name: "Governed recording" })).toBeVisible();
    expect(screen.getAllByText("Pending approval")[0]).toBeVisible();
    expect(screen.getByText("v1")).toBeVisible();
    expect(screen.getAllByText("Assigned reviewer")[0]).toBeVisible();
    expect(screen.getByText("Historical snapshot")).toBeVisible();
    expect(screen.getByText("Ready for review.")) .toBeVisible();
    expect(screen.getByRole("article", { name: /Transcript segment 1, 00:00-00:10/i })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByText("Confidence 83%")).toBeVisible();
    expect(screen.queryByDisplayValue("")) .not.toBeInTheDocument();
  });

  it("registers beforeunload only while dirty and saves with retained focus", async () => {
    const user = userEvent.setup();
    const nextCasefile = createCasefile({
      revision: {
        ...createCasefile().revision,
        id: "rev-2",
        version: 2,
      },
    });
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { saveAction } = renderWorkspace();
    saveAction.mockResolvedValue({
      ok: true,
      data: {
        casefile: nextCasefile,
        nextPath: "/recordings/rec-1",
        focusTarget: "retain",
      },
    });

    const editor = screen.getByRole("textbox", {
      name: "Transcript for segment 1, 00:00-00:10",
    });
    await user.click(editor);
    await user.type(editor, " Updated");

    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(saveAction).toHaveBeenCalledWith(expect.objectContaining({
      expectedCurrentRevisionId: "rev-1",
      actionModeId: null,
    })));
    await waitFor(() => expect(editor).toHaveFocus());
    expect(screen.getByText("v2")).toBeVisible();
    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("keeps local changes, opens session recovery, and shows stale conflict recovery actions", async () => {
    const user = userEvent.setup();
    const { submitAction } = renderWorkspace();
    submitAction
      .mockResolvedValueOnce({
        ok: false,
        code: "AUTH_EXPIRED",
        message: "Session expired. Sign in again to continue.",
      })
      .mockResolvedValueOnce({
        ok: false,
        code: "STALE_REVISION",
        message: "This recording changed since you opened it.",
        latest: {
          recordingId: "rec-1",
          loadedRevisionId: "rev-1",
          currentRevisionId: "rev-9",
          pendingRevisionId: null,
          approvedRevisionId: null,
          winningStage: "draft_review",
        },
      });

    const summary = screen.getByRole("textbox", { name: "Revision summary" });
    await user.clear(summary);
    await user.type(summary, "Local draft summary");
    await user.click(screen.getByRole("button", { name: "Submit for approval" }));

    expect(await screen.findByText("Recover session")).toBeVisible();
    expect(summary).toHaveValue("Local draft summary");

    await user.click(screen.getByRole("button", { name: "Submit for approval" }));

    const conflict = await screen.findByRole("region", { name: "Revision conflict" });
    expect(within(conflict).getByText("Loaded revision: rev-1")).toBeVisible();
    expect(within(conflict).getByText("Current revision: rev-9")).toBeVisible();
    expect(within(conflict).getByRole("link", { name: "Open latest revision in a new tab" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(within(conflict).getByRole("button", { name: "Discard local changes and reload latest" })).toBeVisible();
  });

  it("does not render mutation controls in phone safety mode", () => {
    phoneSafetyModeMock.mockReturnValue(true);
    renderWorkspace();

    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});
