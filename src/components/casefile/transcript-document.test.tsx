// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSegments } from "./test-fixtures";
import { TranscriptDocument } from "./transcript-document";

describe("TranscriptDocument", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders aligned transcript labels, active row state, and confidence text", () => {
    render(
      <TranscriptDocument
        activeSegmentId="seg-2"
        editable
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Revision summary" })).toHaveValue(
      "Ready for review.",
    );
    expect(screen.getByRole("button", { name: "Play from 00:00-00:10" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Speaker for segment 1, 00:00-00:10" })).toHaveValue(
      "Speaker 1",
    );
    expect(screen.getByRole("textbox", { name: "Transcript for segment 1, 00:00-00:10" })).toHaveValue(
      "Hello world.",
    );
    expect(screen.getByRole("article", { name: /Transcript segment 2, 00:10-00:20/i })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByText("Confidence 91%")).toBeVisible();
  });

  it("renders immutable transcript content without disabled blank editors", () => {
    render(
      <TranscriptDocument
        activeSegmentId={null}
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Pending approval summary"
        onSummaryChange={vi.fn()}
      />,
    );

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByText("Speaker 1")).toBeVisible();
    expect(screen.getByText("Hello world.")).toBeVisible();
  });

  it("renders phone safety as plain read-only speaker and text content", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    render(
      <TranscriptDocument
        activeSegmentId={null}
        editable
        onSeek={onSeek}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode
        segments={baseSegments}
        summary="Phone summary"
        onSummaryChange={vi.fn()}
      />,
    );

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Play from 00:00-00:10" }));
    expect(onSeek).toHaveBeenCalledWith(0);
  });
});
