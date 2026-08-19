// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCasefile } from "./test-fixtures";
import { CasefileWorkspace } from "./casefile-workspace";

const phoneSafetyModeMock = vi.fn(() => false);
const pollerMock = vi.fn<(props: unknown) => null>(() => null);
const routerRefreshMock = vi.fn();
const routerPushMock = vi.fn();
const routerReplaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
    push: routerPushMock,
    replace: routerReplaceMock,
  }),
}));

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

function renderWorkspace(overrides: Record<string, unknown> = {}, pageNotice?: string) {
  const saveAction = vi.fn();
  const submitAction = vi.fn();
  const withdrawAction = vi.fn();
  const requestChangesAction = vi.fn();
  const approveAction = vi.fn();
  const renameSpeakerAction = vi.fn();
  const reopenAction = vi.fn();
  const enterAdminActionModeAction = vi.fn();
  const exitAdminActionModeAction = vi.fn();

  const view = render(
    <CasefileWorkspace
      approveAction={approveAction}
      enterAdminActionModeAction={enterAdminActionModeAction}
      exitAdminActionModeAction={exitAdminActionModeAction}
      initialCasefile={createCasefile(overrides)}
      pageNotice={pageNotice}
      renameSpeakerAction={renameSpeakerAction}
      reopenAction={reopenAction}
      requestChangesAction={requestChangesAction}
      saveAction={saveAction}
      submitAction={submitAction}
      withdrawAction={withdrawAction}
    />,
  );

  return {
    approveAction,
    renameSpeakerAction,
    enterAdminActionModeAction,
    exitAdminActionModeAction,
    reopenAction,
    requestChangesAction,
    rerenderWorkspace(nextOverrides: Record<string, unknown>) {
      view.rerender(
        <CasefileWorkspace
          approveAction={approveAction}
          renameSpeakerAction={renameSpeakerAction}
          enterAdminActionModeAction={enterAdminActionModeAction}
          exitAdminActionModeAction={exitAdminActionModeAction}
          initialCasefile={createCasefile(nextOverrides)}
          reopenAction={reopenAction}
          requestChangesAction={requestChangesAction}
          saveAction={saveAction}
          submitAction={submitAction}
          withdrawAction={withdrawAction}
        />,
      );
    },
    saveAction,
    submitAction,
    withdrawAction,
  };
}

function createAdminOversightCasefile(overrides: Record<string, unknown> = {}) {
  return createCasefile({
    access: {
      kind: "admin_oversight",
      recordingId: "rec-1",
      historical: false,
    },
    assignmentLabel: "Admin oversight",
    adminActionModeOptions: [{ effectiveRole: "reviewer" }, { effectiveRole: "approver" }],
    capabilities: {
      ...createCasefile().capabilities,
      canEdit: false,
      canSave: false,
      canSubmit: false,
      canWithdraw: false,
      canApprove: false,
      canRequestChanges: false,
      canReopen: false,
      canExport: false,
      denials: {
        ...createCasefile().capabilities.denials,
        canEdit: "admin_action_mode_required",
        canSave: "admin_action_mode_required",
        canSubmit: "admin_action_mode_required",
        canWithdraw: "admin_action_mode_required",
        canApprove: "admin_action_mode_required",
        canRequestChanges: "admin_action_mode_required",
        canReopen: "admin_action_mode_required",
        canExport: "admin_action_mode_required",
      },
    },
    nextActions: [],
    ...overrides,
  });
}

function createAdminReviewerActionModeCasefile(overrides: Record<string, unknown> = {}) {
  return createAdminOversightCasefile({
    actionMode: {
      id: "mode-1",
      effectiveRole: "reviewer",
      expiresAt: "2026-08-01T12:30:00.000Z",
      purpose: "Cover the assigned reviewer's documented absence.",
      adminDisplayName: "Admin",
      baseRole: "admin",
    },
    capabilities: {
      ...createCasefile().capabilities,
      canEdit: true,
      canSave: true,
      canSubmit: true,
      denials: {
        ...createCasefile().capabilities.denials,
        canEdit: null,
        canSave: null,
        canSubmit: null,
      },
    },
    nextActions: [
      { capability: "canEdit", label: "Continue editing" },
      { capability: "canSubmit", label: "Submit for approval" },
    ],
    ...overrides,
  });
}

function createAdminApproverActionModeCasefile(overrides: Record<string, unknown> = {}) {
  return createAdminOversightCasefile({
    actionMode: {
      id: "mode-approver",
      effectiveRole: "approver",
      expiresAt: "2026-08-01T12:30:00.000Z",
      purpose: "Export the governed transcript for the approved handoff.",
      adminDisplayName: "Admin",
      baseRole: "admin",
    },
    capabilities: {
      ...createCasefile().capabilities,
      canExport: true,
      denials: {
        ...createCasefile().capabilities.denials,
        canExport: null,
      },
    },
    ...overrides,
  });
}

describe("CasefileWorkspace", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    phoneSafetyModeMock.mockReturnValue(false);
    pollerMock.mockClear();
    routerRefreshMock.mockReset();
    routerPushMock.mockReset();
    routerReplaceMock.mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tags the casefile page with the media kind so CSS can scope the video transcript budget", () => {
    renderWorkspace({
      media: { kind: "video", url: "https://example.test/v.mp4", denialReason: null },
    });
    // Video casefiles carry the captain's 2026-08-19 ruling (original-size
    // frame plus a video-scoped transcript budget); audio casefiles render
    // the pinned-zone layout untouched, which the styles test pins down.
    expect(document.querySelector(".casefile-page")).toHaveAttribute(
      "data-media-kind",
      "video",
    );
  });

  it("renders a page-level success notice from the recording route", () => {
    renderWorkspace({}, "Recovered archived content into active draft v3; history kept.");

    expect(screen.getByText("Recovered archived content into active draft v3; history kept.")).toHaveTextContent(
      "Recovered archived content into active draft v3; history kept.",
    );
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

  it("enters admin action mode via canonical replace and syncs same-revision capabilities from the server", async () => {
    const user = userEvent.setup();
    const { enterAdminActionModeAction, rerenderWorkspace } = renderWorkspace(
      createAdminOversightCasefile(),
    );
    enterAdminActionModeAction.mockResolvedValue({
      ok: true,
      notice: "Admin action mode entered as reviewer.",
      data: {
        href: "/recordings/rec-1?actionMode=mode-1",
        session: {
          id: "mode-1",
          effectiveRole: "reviewer",
          purpose: "Cover the assigned reviewer's documented absence.",
          expiresAt: "2026-08-01T12:30:00.000Z",
          adminDisplayName: "Admin",
          baseRole: "admin",
        },
      },
    });

    await user.click(screen.getByRole("button", { name: "Enter reviewer action mode" }));
    const dialog = await screen.findByRole("dialog", { name: "Enter admin action mode" });
    fireEvent.change(within(dialog).getByLabelText("Purpose"), {
      target: { value: "Cover the assigned reviewer's documented absence." },
    });
    const confirmButton = screen.getAllByRole("button", { name: "Enter reviewer action mode" })[1];
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() =>
      expect(enterAdminActionModeAction).toHaveBeenCalledWith({
        recordingId: "rec-1",
        effectiveRole: "reviewer",
        purpose: "Cover the assigned reviewer's documented absence.",
      }),
    );
    await waitFor(() =>
      expect(routerReplaceMock).toHaveBeenCalledWith("/recordings/rec-1?actionMode=mode-1", {
        scroll: false,
      }),
    );
    expect(screen.queryByLabelText("Admin action mode")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();

    rerenderWorkspace(createAdminReviewerActionModeCasefile());

    expect(await screen.findByLabelText("Admin action mode")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeVisible();
    expect(
      screen.getByRole("textbox", {
        name: "Transcript for segment 1, 00:00-00:10",
      }),
    ).not.toHaveAttribute("readonly");
  });

  it("exits admin action mode via canonical replace and removes same-revision governed controls on rerender", async () => {
    const user = userEvent.setup();
    const { exitAdminActionModeAction, rerenderWorkspace } = renderWorkspace(
      createAdminReviewerActionModeCasefile(),
    );
    exitAdminActionModeAction.mockResolvedValue({
      ok: true,
      notice: "Admin action mode exited.",
      data: {
        href: "/recordings/rec-1",
      },
    });

    await user.click(screen.getByRole("button", { name: "Exit action mode" }));

    await waitFor(() =>
      expect(routerReplaceMock).toHaveBeenCalledWith("/recordings/rec-1", {
        scroll: false,
      }),
    );

    rerenderWorkspace(createAdminOversightCasefile());

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Revision summary" })).not.toBeInTheDocument();
    expect(screen.getByText("Hello world.")).toBeVisible();
  });

  it("preserves dirty text while syncing same-revision action-mode expiry", async () => {
    const user = userEvent.setup();
    const { rerenderWorkspace } = renderWorkspace(createAdminReviewerActionModeCasefile());

    const editor = screen.getByRole("textbox", {
      name: "Transcript for segment 1, 00:00-00:10",
    });
    await user.clear(editor);
    await user.type(editor, "Local admin reviewer draft.");

    rerenderWorkspace(
      createAdminOversightCasefile({
        actionMode: null,
      }),
    );

    expect(screen.queryByRole("textbox", { name: "Transcript for segment 1, 00:00-00:10" })).not.toBeInTheDocument();
    expect(screen.getByText("Local admin reviewer draft.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
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
        transcribedUntilMs: 25_000,
        audioDurationMs: 60_000,
        segmentsSeen: 7,
        etaSeconds: 18,
        verificationSummary: "Verifying upload.",
        recoveryHint: "Keep this tab open while transcript preparation finishes.",
      },
    });

    const bar = screen.getByRole("progressbar", { name: "Transcription progress" });
    expect(bar).toBeVisible();
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText(/Segment 7/)).toBeVisible();
    expect(screen.getByText(/0:25 of 1:00/)).toBeVisible();
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

  it("keeps follow dormant when unavailable media rejects a timestamp seek", async () => {
    // casefile-pin-transcript-zone: a rejected seek (media unavailable) must
    // never activate follow or center a stale row.
    const user = userEvent.setup();
    const scrollIntoView = vi.spyOn(
      window.HTMLElement.prototype,
      "scrollIntoView",
    );
    renderWorkspace({
      media: {
        kind: "audio",
        url: null,
        denialReason: "No media asset is attached to this recording yet.",
      },
    });
    scrollIntoView.mockClear();

    await user.click(
      screen.getByRole("button", {
        name: "Play or pause segment 1, 00:00-00:10",
      }),
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
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

  it("saves only the changed segment fields as a patch payload", async () => {
    const user = userEvent.setup();
    const nextCasefile = createCasefile({
      revision: {
        ...createCasefile().revision,
        id: "rev-2",
        version: 2,
      },
    });
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
    const speakerField = screen.getByRole("textbox", {
      name: "Speaker for segment 2, 00:10-00:20",
    });
    await user.clear(speakerField);
    await user.type(speakerField, "Interviewer");

    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(saveAction).toHaveBeenCalledWith({
        recordingId: "rec-1",
        expectedCurrentRevisionId: "rev-1",
        summary: "Ready for review.",
        edits: [
          { id: "seg-1", text: "Hello world. Updated" },
          { id: "seg-2", speakerLabel: "Interviewer" },
        ],
        actionModeId: null,
      }),
    );
  });

  it("submits pending edits as a patch with the unsaved-changes flag", async () => {
    const user = userEvent.setup();
    const { submitAction } = renderWorkspace();
    submitAction.mockResolvedValue({
      ok: true,
      data: {
        casefile: createCasefile({
          revision: { ...createCasefile().revision, id: "rev-2", version: 2 },
        }),
        nextPath: "/recordings/rec-1",
        focusTarget: "case-state",
      },
    });

    const editor = screen.getByRole("textbox", {
      name: "Transcript for segment 2, 00:10-00:20",
    });
    await user.click(editor);
    await user.type(editor, "!");

    await user.click(screen.getByRole("button", { name: "Submit for approval" }));
    const dialog = await screen.findByRole("dialog", { name: "Submit for approval" });
    await user.click(within(dialog).getByRole("button", { name: "Submit for approval" }));

    await waitFor(() =>
      expect(submitAction).toHaveBeenCalledWith(
        expect.objectContaining({
          edits: [{ id: "seg-2", text: "General Kenobi.!" }],
          hasUnsavedChanges: true,
        }),
      ),
    );
  });

  it("preserves the active segment across a successful save", async () => {
    const user = userEvent.setup();
    const nextCasefile = createCasefile({
      revision: {
        ...createCasefile().revision,
        id: "rev-2",
        version: 2,
      },
    });
    const { saveAction } = renderWorkspace();
    saveAction.mockResolvedValue({
      ok: true,
      data: {
        casefile: nextCasefile,
        nextPath: "/recordings/rec-1",
        focusTarget: "retain",
      },
    });

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    audio!.currentTime = 15;
    fireEvent.timeUpdate(audio!);
    expect(
      screen.getByRole("article", { name: /Transcript segment 2, 00:10-00:20/i }),
    ).toHaveAttribute("aria-current", "true");

    const editor = screen.getByRole("textbox", {
      name: "Transcript for segment 1, 00:00-00:10",
    });
    await user.type(editor, " Updated");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(screen.getByText("v2")).toBeVisible());
    expect(
      screen.getByRole("article", { name: /Transcript segment 2, 00:10-00:20/i }),
    ).toHaveAttribute("aria-current", "true");
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
    await user.click(screen.getAllByRole("button", { name: "Submit for approval" })[1]);

    expect(await screen.findByText("Recover session")).toBeVisible();
    expect(summary).toHaveValue("Local draft summary");

    await user.click(screen.getAllByRole("button", { name: "Submit for approval" })[1]);

    const conflict = await screen.findByRole("region", { name: "Revision conflict" });
    expect(within(conflict).getByText("Loaded revision: rev-1")).toBeVisible();
    expect(within(conflict).getByText("Current revision: rev-9")).toBeVisible();
    expect(within(conflict).getByRole("link", { name: "Open latest revision in a new tab" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(within(conflict).getByRole("button", { name: "Discard local changes and reload latest" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
  });

  it("shows a safe completed-without-revision notice and no capability controls", () => {
    renderWorkspace({
      stage: "completed",
      stageLabel: "Completed",
      revision: null,
      revisions: [],
      capabilities: {
        ...createCasefile().capabilities,
        canEdit: false,
        canSave: false,
        canSubmit: false,
        canWithdraw: false,
        canApprove: false,
        canRequestChanges: false,
        canReopen: false,
        canExport: false,
      },
      nextActions: [],
      processing: {
        active: false,
        integrityState: "verified",
        transcriptJobState: "completed",
        progressPercent: null,
        etaSeconds: null,
        verificationSummary: "Transcript processing completed.",
        recoveryHint: "Return to Work while the governed revision is repaired.",
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Transcript processing completed without a revision.",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
  });

  it("pushes a reopened workspace redirect with an encoded notice query and no local retry", async () => {
    const user = userEvent.setup();
    const { reopenAction } = renderWorkspace({
      stage: "approved",
      stageLabel: "Approved",
      assignmentLabel: "Assigned approver",
      revision: {
        ...createCasefile().revision,
        id: "rev-3",
        state: "approved",
        stateLabel: "Approved",
        approvedAt: "2026-08-01T12:05:00.000Z",
      },
      capabilities: {
        ...createCasefile().capabilities,
        canEdit: false,
        canSave: false,
        canSubmit: false,
        canWithdraw: false,
        canApprove: false,
        canRequestChanges: false,
        canReopen: true,
      },
      nextActions: [{ capability: "canReopen", label: "Reopen as draft" }],
    });
    reopenAction.mockResolvedValue({
      ok: true,
      notice: "Casefile reopened. An administrator must assign the new review cycle.",
      data: {
        casefile: null,
        nextPath: "/workspace?tab=assigned",
        focusTarget: "case-state",
      },
    });

    await user.click(screen.getByRole("button", { name: "Reopen as draft" }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen as draft" });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "A new governed cycle needs reassignment." },
    });
    await user.click(within(screen.getByRole("dialog", { name: "Reopen as draft" })).getByRole("button", {
      name: "Reopen as draft",
    }));

    await waitFor(() => expect(reopenAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(routerPushMock).toHaveBeenCalledWith(
        "/workspace?tab=assigned&notice=Casefile+reopened.+An+administrator+must+assign+the+new+review+cycle.",
      ),
    );
    expect(routerRefreshMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Recover session")).not.toBeInTheDocument();
  });

  it("does not render mutation controls in phone safety mode", () => {
    phoneSafetyModeMock.mockReturnValue(true);
    renderWorkspace();

    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("hides an open speaker rename dialog when phone safety begins", async () => {
    const user = userEvent.setup();
    const { renameSpeakerAction, rerenderWorkspace } = renderWorkspace();

    await user.click(screen.getByRole("button", { name: "Rename speaker..." }));
    expect(
      screen.getByRole("dialog", { name: "Rename speaker everywhere" }),
    ).toBeVisible();

    phoneSafetyModeMock.mockReturnValue(true);
    rerenderWorkspace({});

    expect(
      screen.queryByRole("dialog", { name: "Rename speaker everywhere" }),
    ).not.toBeInTheDocument();
    expect(renameSpeakerAction).not.toHaveBeenCalled();
  });

  it("hides the header governance trigger in phone safety mode", () => {
    phoneSafetyModeMock.mockReturnValue(true);
    renderWorkspace();

    expect(screen.queryByRole("button", { name: /^Governance/ })).not.toBeInTheDocument();
  });

  it("renders the header governance trigger on non-phone surfaces", () => {
    renderWorkspace();

    expect(screen.getByRole("button", { name: /^Governance/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it.each([
    ["without an active action-mode session", createAdminOversightCasefile()],
    [
      "on a historical revision snapshot",
      createAdminOversightCasefile({
        access: {
          kind: "admin_oversight",
          recordingId: "rec-1",
          historical: true,
        },
        adminActionModeOptions: [],
        historicalLabel: "Historical snapshot",
      }),
    ],
    ["while reviewer action mode is active", createAdminReviewerActionModeCasefile()],
  ])("offers approver action-mode entry in Governance %s", async (_state, casefile) => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
      writable: true,
    });
    renderWorkspace(casefile);

    await user.click(screen.getByRole("button", { name: /^Governance/ }));

    const governance = await screen.findByRole("complementary", { name: "Governance" });
    expect(
      within(governance).getByRole("button", { name: "Enter approver action mode" }),
    ).toBeVisible();
  });

  it("offers Governance recovery after export rejects a cached approver session", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
      writable: true,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: vi.fn().mockResolvedValue(
        "This admin action mode expired. Enter admin action mode again.",
      ),
    } as unknown as Response);
    renderWorkspace(createAdminApproverActionModeCasefile());

    expect(
      screen.queryByRole("button", { name: "Enter approver action mode" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Export transcript" }));
    const exportDialog = await screen.findByRole("dialog", { name: "Export approved transcript" });
    await user.click(within(exportDialog).getByRole("button", { name: "DOCX" }));
    expect(
      await within(exportDialog).findByText(/This admin action mode expired/),
    ).toBeVisible();
    await user.click(within(exportDialog).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: /^Governance/ }));

    const governance = await screen.findByRole("complementary", { name: "Governance" });
    expect(
      within(governance).getByRole("button", { name: "Enter approver action mode" }),
    ).toBeVisible();
  });

  it("disables revisionless admin export and omits its Governance entry", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderWorkspace(createAdminOversightCasefile({
      revision: null,
      revisions: [],
    }));

    const exportButton = screen.getByRole("button", { name: "Export transcript" });
    expect(exportButton).toBeDisabled();
    expect(
      screen.getByText("Export unlocks once the first transcript revision exists."),
    ).toBeVisible();

    await user.click(exportButton);

    expect(screen.queryByRole("dialog", { name: "Export approved transcript" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Governance/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enter approver action mode" }),
    ).not.toBeInTheDocument();
  });

  it("pins the governed delete control in the sticky action bar for admin oversight only", () => {
    renderWorkspace(createAdminOversightCasefile());

    const actionBar = screen.getByRole("region", { name: "Case actions" });
    expect(
      within(actionBar).getByRole("button", { name: "Delete recording permanently..." }),
    ).toBeVisible();

    cleanup();
    renderWorkspace(createCasefile());
    expect(
      screen.queryByRole("button", { name: "Delete recording permanently..." }),
    ).toBeNull();
  });

  it("keeps the pinned delete confirmation flow intact from the action bar", async () => {
    const user = userEvent.setup();
    renderWorkspace(createAdminOversightCasefile());

    await user.click(screen.getByRole("button", { name: "Delete recording permanently..." }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete this recording permanently?",
    });
    expect(dialog).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Delete permanently" }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Keep the recording" }));
    expect(
      screen.queryByRole("dialog", { name: "Delete this recording permanently?" }),
    ).toBeNull();
  });

  it("withholds the pinned delete control under phone safety like the other governed actions", () => {
    phoneSafetyModeMock.mockReturnValue(true);
    renderWorkspace(createAdminOversightCasefile());

    expect(
      screen.queryByRole("button", { name: "Delete recording permanently..." }),
    ).toBeNull();
    expect(
      screen.getByText("Review and decisions require a tablet or desktop."),
    ).toBeVisible();
  });

  it("offers the revision snapshot navigator to admin oversight (demo-governance-bringback)", async () => {
    const user = userEvent.setup();
    const adminCasefile = createAdminOversightCasefile({
      revisions: [
        {
          ...createCasefile().revisions[0],
          id: "rev-1",
          version: 2,
          state: "draft",
          stateLabel: "Draft",
        },
        {
          ...createCasefile().revisions[0],
          id: "rev-0",
          version: 1,
          state: "superseded",
          stateLabel: "Superseded",
        },
      ],
    });

    renderWorkspace(adminCasefile);

    const select = screen.getByRole("combobox", { name: "Choose a revision snapshot" });
    expect(select).toBeVisible();

    const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });
    await user.selectOptions(select, "rev-0");
    // Hard navigation - the snapshot view swaps the whole casefile model
    // (same contract as the recover/purge hard navigations).
    expect(assign).toHaveBeenCalledWith("/recordings/rec-1?revision=rev-0");
    if (locationDescriptor) {
      Object.defineProperty(window, "location", locationDescriptor);
    }

    cleanup();
    renderWorkspace(createCasefile());
    expect(
      screen.queryByRole("combobox", { name: "Choose a revision snapshot" }),
    ).toBeNull();
  });
});
