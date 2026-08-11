// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import type { WorkInboxRow } from "@/server/work-inbox/service";
import { RecordingLedger } from "./recording-ledger";

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

const reviewerRow: WorkInboxRow = {
  recordingId: "REC-SEARCH",
  title: "Alpha dictation",
  stage: "draft_review",
  stageLabel: "Draft review",
  source: "upload",
  sourceLabel: "Upload",
  revisionLabel: "Draft",
  progressLabel: "Draft review",
  assignmentLabel: "Assigned to you",
  updatedAt: "2026-08-01T12:03:00.000Z",
  updatedAtLabel: "01 Aug 2026, 12:03 UTC",
  updatedAtIso: "2026-08-01T12:03:00.000Z",
  href: "/recordings/REC-SEARCH",
  actionable: true,
  actionLabel: "Open draft",
  tabId: "to-review",
  assignmentUserIds: ["reviewer-1"],
};

const uploaderRow: WorkInboxRow = {
  recordingId: "rec-owned",
  title: "Owned ready item",
  stage: "approved",
  stageLabel: "Approved",
  source: "upload",
  sourceLabel: "Upload",
  revisionLabel: "Approved",
  progressLabel: "Approved",
  assignmentLabel: "Uploaded by you",
  updatedAt: "2026-08-01T12:01:00.000Z",
  updatedAtLabel: "01 Aug 2026, 12:01 UTC",
  updatedAtIso: "2026-08-01T12:01:00.000Z",
  href: "/recordings/rec-owned?revision=rev-owned",
  actionable: false,
  actionLabel: null,
  tabId: "ready",
  assignmentUserIds: ["uploader-1"],
};

const completedReviewerRow: WorkInboxRow = {
  ...reviewerRow,
  recordingId: "rec-approved",
  title: "Completed reviewer item",
  stage: "approved",
  stageLabel: "Approved",
  revisionLabel: "Approved",
  progressLabel: "Approved",
  assignmentLabel: "Completed snapshot",
  updatedAt: "2026-08-01T12:01:00.000Z",
  updatedAtLabel: "01 Aug 2026, 12:01 UTC",
  updatedAtIso: "2026-08-01T12:01:00.000Z",
  href: "/recordings/rec-approved?revision=rev-approved",
  actionable: false,
  actionLabel: "View snapshot",
  tabId: "completed",
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const transcribingRow: WorkInboxRow = {
  recordingId: "rec-live",
  title: "Live dictation",
  stage: "transcribing",
  stageLabel: "Transcribing",
  source: "upload",
  sourceLabel: "Upload",
  revisionLabel: "None yet",
  progressLabel: "Transcribing",
  assignmentLabel: "Uploaded by you",
  updatedAt: "2026-08-01T12:03:00.000Z",
  updatedAtLabel: "01 Aug 2026, 12:03 UTC",
  updatedAtIso: "2026-08-01T12:03:00.000Z",
  href: "/recordings/rec-live",
  actionable: false,
  actionLabel: null,
  tabId: "mine",
  assignmentUserIds: [],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe("RecordingLedger", () => {
  beforeEach(() => {
    setViewport(1280);
    mockRefresh.mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ jobs: [] })));
  });

  it("renders a semantic desktop table with row facts, chips, UTC text, and one action", () => {
    render(<RecordingLedger role="reviewer" rows={[reviewerRow]} />);

    expect(screen.getByRole("table", { name: "Work recordings" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Work recordings" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Assignment" })).toBeVisible();

    const rowHeader = screen.getByRole("rowheader", { name: /Alpha dictation/i });
    const row = rowHeader.closest("tr");
    expect(row).not.toBeNull();
    expect(rowHeader).toHaveTextContent("REC-SEARCH");
    expect(within(row!).getByLabelText("Assignment: Assigned to you")).toBeVisible();
    expect(within(row!).getByText("Draft review")).toBeVisible();
    expect(within(row!).getByText("Draft")).toBeVisible();
    expect(within(row!).getByText("01 Aug 2026, 12:03 UTC")).toBeVisible();
    expect(within(row!).getByText(/2026-08-01T12:03:00.000Z/)).toHaveClass("sr-only");
    expect(within(row!).getAllByRole("link")).toHaveLength(1);

    const action = within(row!).getByRole("link", { name: "Alpha dictation" });
    expect(action).toHaveAttribute("href", "/recordings/REC-SEARCH");
    expect(action).toHaveTextContent("Open draft");
    expect(row?.querySelector(".status-badge__icon")).not.toBeNull();
  });

  it("omits the desktop row action when the server does not supply an action label", () => {
    render(<RecordingLedger role="uploader" rows={[uploaderRow]} />);

    const rowHeader = screen.getByRole("rowheader", { name: /Owned ready item/i });
    const row = rowHeader.closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a labeled narrow list below 960 px without duplicating the desktop table", () => {
    setViewport(390);
    render(<RecordingLedger role="uploader" rows={[uploaderRow]} />);

    expect(screen.getByRole("list", { name: "Work recordings" })).toBeVisible();
    expect(screen.queryByRole("table", { name: "Work recordings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Assignment" })).not.toBeInTheDocument();
    expect(screen.getByText("Uploaded by you")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps the mobile action text visible while exposing the recording title as the link name", () => {
    setViewport(390);
    render(<RecordingLedger role="reviewer" rows={[reviewerRow]} />);

    const item = screen.getByRole("listitem");
    const action = within(item).getByRole("link", { name: "Alpha dictation" });
    expect(action).toHaveAttribute("href", "/recordings/REC-SEARCH");
    expect(action).toHaveTextContent("Open draft");
  });

  it("renders completed snapshot links on the mobile list with title-based names", () => {
    setViewport(390);
    render(<RecordingLedger role="reviewer" rows={[completedReviewerRow]} />);

    const item = screen.getByRole("listitem");
    const action = within(item).getByRole("link", { name: "Completed reviewer item" });
    expect(action).toHaveAttribute("href", "/recordings/rec-approved?revision=rev-approved");
    expect(action).toHaveTextContent("View snapshot");
  });

  it("swaps the transcribing badge for the live engine progress bar once the batch poll lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobs: [
            {
              recordingId: "rec-live",
              state: "running",
              progressPercent: 42,
              transcribedUntilMs: 25_000,
              audioDurationMs: 60_000,
              segmentsSeen: 7,
              updatedAt: "2026-08-01T12:03:05.000Z",
            },
          ],
        }),
      ),
    );

    render(<RecordingLedger role="reviewer" rows={[transcribingRow]} />);

    const bar = await screen.findByRole("progressbar", { name: "Transcription progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText(/Segment 7/)).toBeVisible();
    expect(screen.getByText(/0:25 of 1:00/)).toBeVisible();
    expect(screen.getByText("Transcribing 42%")).toBeVisible();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/recordings/progress?ids=${encodeURIComponent("rec-live")}`,
      { cache: "no-store" },
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("refreshes the governed row once when a tracked job leaves the in-flight states", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          jobs: [
            {
              recordingId: "rec-live",
              state: "completed",
              progressPercent: 100,
              transcribedUntilMs: 60_000,
              audioDurationMs: 60_000,
              segmentsSeen: 11,
              updatedAt: "2026-08-01T12:03:30.000Z",
            },
          ],
        }),
      )
      .mockResolvedValue(jsonResponse({ jobs: [] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<RecordingLedger role="reviewer" rows={[transcribingRow]} />);

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    // Completed jobs fall back to the governed stage label, not a progress bar.
    await waitFor(() =>
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument(),
    );
  });

  it("does not poll at all when no visible row is transcribing", async () => {
    render(<RecordingLedger role="reviewer" rows={[reviewerRow, uploaderRow]} />);

    await Promise.resolve();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
