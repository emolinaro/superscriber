// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});

describe("RecordingLedger", () => {
  beforeEach(() => {
    setViewport(1280);
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
});
