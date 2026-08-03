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
          integrityState: "verifying",
          transcriptJobState: "running",
          progressPercent: 42,
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

    expect(screen.getByText("42% complete")).toBeVisible();

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
});
