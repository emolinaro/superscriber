// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseSegments } from "./test-fixtures";
import { TranscriptDocument } from "./transcript-document";

describe("TranscriptDocument", () => {
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;
  let reducedMotion: boolean;

  beforeEach(() => {
    reducedMotion = false;
    scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: reducedMotion,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

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

  it("names the withheld editors on the phone-safety surface", () => {
    render(
      <TranscriptDocument
        activeSegmentId={null}
        editable
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode
        safetyStripped
        segments={baseSegments}
        summary="Phone summary"
        onSummaryChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Review and decisions require a tablet or desktop\./),
    ).toBeVisible();
  });

  it("keeps permission-based read-only rendering free of the device copy", () => {
    render(
      <TranscriptDocument
        activeSegmentId={null}
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode
        segments={baseSegments}
        summary="Viewer summary"
        onSummaryChange={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/Review and decisions require a tablet or desktop\./),
    ).toBeNull();
  });

  it("scrolls the active row into the nearest scrollport as playback advances", () => {
    const { rerender } = render(
      <TranscriptDocument
        activeSegmentId={null}
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    rerender(
      <TranscriptDocument
        activeSegmentId="seg-2"
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
  });

  it("uses an instant follow-scroll under prefers-reduced-motion", () => {
    reducedMotion = true;
    render(
      <TranscriptDocument
        activeSegmentId="seg-2"
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "auto",
    });
  });

  it("marks segments the viewed revision edited with an 'Edited vs vN' badge", () => {
    render(
      <TranscriptDocument
        activeSegmentId={null}
        diffHighlight={{ parentVersion: 2, editedSegmentIds: ["seg-1"] }}
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Reopened draft"
        onSummaryChange={vi.fn()}
      />,
    );

    const first = screen.getByRole("article", { name: /Transcript segment 1,/ });
    expect(first.querySelector(".transcript-segment__diff-flag")).toHaveTextContent(
      "Edited vs v2",
    );
    const second = screen.getByRole("article", { name: /Transcript segment 2,/ });
    expect(second.querySelector(".transcript-segment__diff-flag")).toBeNull();
  });

  it("scrolls and focuses the located segment's review affordance on review focus", () => {
    reducedMotion = true;
    render(
      <TranscriptDocument
        activeSegmentId={null}
        editable
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        reviewFocus={{ segmentId: "seg-2", nonce: 1 }}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "auto",
    });
    expect(
      screen.getByRole("textbox", { name: "Transcript for segment 2, 00:10-00:20" }),
    ).toHaveFocus();
  });
});
