// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasefileWorkspace } from "./casefile-workspace";
import { createCasefile } from "./test-fixtures";

const { mockRefresh } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => false,
}));

vi.mock("@/components/auth/session-recovery-dialog", () => ({
  SessionRecoveryDialog: () => null,
}));

function renderStatusOnlyWorkspace(overrides: Record<string, unknown> = {}) {
  return render(
    <CasefileWorkspace
      approveAction={vi.fn()}
      renameSpeakerAction={vi.fn()}
      enterAdminActionModeAction={vi.fn()}
      exitAdminActionModeAction={vi.fn()}
      initialCasefile={createCasefile({
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
          transcribedUntilMs: null,
          audioDurationMs: null,
          segmentsSeen: null,
          etaSeconds: 18,
          verificationSummary: "Verifying upload.",
          recoveryHint: "Keep this tab open while transcript preparation finishes.",
        },
        ...overrides,
      })}
      reopenAction={vi.fn()}
      requestChangesAction={vi.fn()}
      saveAction={vi.fn()}
      submitAction={vi.fn()}
      withdrawAction={vi.fn()}
    />,
  );
}

function createStatusSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    workflowStage: "draft_review",
    currentRevisionVersion: null,
    currentRevisionId: null,
    approvedRevisionId: null,
    pendingRevisionId: null,
    progress: {
      integrityState: "verified",
      transcriptJobState: "running",
      transcriptJobProgressPercent: 51,
      transcriptJobEtaSeconds: 12,
    },
    updatedAt: "2026-08-01T12:00:03.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

async function advancePollingWindow() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.resolve();
  });
}

describe("CasefileWorkspace status-only polling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRefresh.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mounts one active uploader poller and keeps the shared 3 second stage and 10 percent refresh semantics", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(createStatusSnapshot()))
      .mockResolvedValueOnce(
        jsonResponse(
          createStatusSnapshot({
            workflowStage: "approved",
            currentRevisionVersion: 2,
            currentRevisionId: "rev-2",
            approvedRevisionId: "rev-2",
            progress: {
              integrityState: "verified",
              transcriptJobState: "completed",
              transcriptJobProgressPercent: 100,
              transcriptJobEtaSeconds: null,
            },
            updatedAt: "2026-08-01T12:00:06.000Z",
          }),
        ),
      );

    const view = renderStatusOnlyWorkspace();

    const bar = screen.getByRole("progressbar", { name: "Transcription progress" });
    expect(bar).toBeVisible();
    expect(bar).toHaveAttribute("aria-valuenow", "42");

    await advancePollingWindow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/recordings/rec-1/status", {
      cache: "no-store",
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Transcript processing reached 50 percent.",
    );

    await advancePollingWindow();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Case stage updated to approved.");

    await advancePollingWindow();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.unmount();

    await advancePollingWindow();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the stage label instead of the transcription bar during integrity verification", () => {
    renderStatusOnlyWorkspace({
      stageLabel: "Verifying upload",
      processing: {
        active: true,
        integrityState: "verifying",
        transcriptJobState: "queued",
        progressPercent: null,
        transcribedUntilMs: null,
        audioDurationMs: null,
        segmentsSeen: null,
        etaSeconds: 90,
        verificationSummary: "Awaiting server-side verification.",
        recoveryHint: null,
      },
    });

    expect(
      screen.queryByRole("progressbar", { name: "Transcription progress" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/engine warming up/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Verifying upload").length).toBeGreaterThan(0);
  });

  it("renders the transcription bar once the engine pipeline is queued after verification", () => {
    renderStatusOnlyWorkspace({
      stageLabel: "Transcribing",
      processing: {
        active: true,
        integrityState: "verified",
        transcriptJobState: "queued",
        progressPercent: null,
        transcribedUntilMs: null,
        audioDurationMs: null,
        segmentsSeen: null,
        etaSeconds: 90,
        verificationSummary: "Queued for transcription.",
        recoveryHint: null,
      },
    });

    const bar = screen.getByRole("progressbar", { name: "Transcription progress" });
    expect(bar).toBeVisible();
    expect(bar).toHaveAttribute("data-live", "warming");
  });
});

describe("CasefileWorkspace guided failure card", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRefresh.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderFailureCard(failure: Record<string, unknown>) {
    return renderStatusOnlyWorkspace({
      stage: "needs_ingest_attention",
      stageLabel: "Needs ingest attention",
      processing: {
        active: false,
        integrityState: "verified",
        transcriptJobState: "failed",
        progressPercent: null,
        transcribedUntilMs: null,
        audioDurationMs: null,
        segmentsSeen: null,
        etaSeconds: null,
        verificationSummary: "Verified",
        recoveryHint: null,
        failure,
      },
    });
  }

  it("shows cause, action, and operator phrase - never the engine stack", () => {
    renderFailureCard({
      errorClass: "mel-shape-mismatch",
      causeLabel:
        "Transcription failed - the speech model involved does not match its audio configuration (model/config mismatch).",
      actionHint: "Delete this recording and upload it again.",
      technicalDetail: null,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("model/config mismatch");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Delete this recording and upload it again.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "contact your operator with these words: mel-shape-mismatch",
    );
    expect(
      screen.queryByText(/Invalid input features shape/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Technical details/)).not.toBeInTheDocument();
  });

  it("exposes the technical detail lines only when the server grants them", () => {
    renderFailureCard({
      errorClass: "mel-shape-mismatch",
      causeLabel: "Transcription failed - model/config mismatch.",
      actionHint: "Delete this recording and upload it again.",
      technicalDetail:
        "model=large-v3 n_mels_expected=128 n_mels_prepared=80 ValueError: Invalid input features shape ...",
    });

    expect(screen.getByText("Technical details (admin only)")).toBeInTheDocument();
    expect(
      screen.getByText(/n_mels_expected=128/),
    ).toBeInTheDocument();
  });
});
