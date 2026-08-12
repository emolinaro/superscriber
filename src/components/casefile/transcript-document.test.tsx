// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(onSeek).toHaveBeenCalledWith(expect.objectContaining({ id: "seg-1", startMs: 0 }));
  });

  it("exposes the active playing segment button as a pressed pause toggle", () => {
    render(
      <TranscriptDocument
        activeSegmentId="seg-1"
        activeSegmentPlaying
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Summary"
        onSummaryChange={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Play or pause segment 1, 00:00-00:10",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Inactive segments keep the plain seek-and-play affordance.
    expect(
      screen.getByRole("button", { name: "Play from 00:10-00:20" }),
    ).not.toHaveAttribute("aria-pressed");
  });

  it("shows the active segment button as unpressed once playback is paused", () => {
    render(
      <TranscriptDocument
        activeSegmentId="seg-1"
        activeSegmentPlaying={false}
        editable={false}
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Summary"
        onSummaryChange={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Play or pause segment 1, 00:00-00:10",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
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

  it("centers the active row in the scrollport as playback advances", () => {
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
      block: "center",
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
      block: "center",
      behavior: "auto",
    });
  });

  it("pauses follow after a user scroll gesture and resumes when the active line is back in view", () => {
    // jsdom reports zero geometry, so a row reads as out of view unless the
    // rect is stubbed - exactly what the pause contract needs for this test.
    const { rerender } = render(
      <TranscriptDocument
        activeSegmentId="seg-1"
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
    scrollIntoViewMock.mockClear();

    // A wheel gesture anywhere outside the transport rail is a manual
    // transcript scroll: follow pauses.
    fireEvent(window, new Event("wheel"));
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
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // When the active line intersects the scrollport again, follow
    // re-engages and centers it. The coming active row is segment 1, so
    // give that row a rect that visibly intersects the window viewport.
    const row = screen.getByRole("article", { name: /Transcript segment 1,/ });
    const zeroRect = row.getBoundingClientRect();
    row.getBoundingClientRect = () =>
      ({ ...zeroRect, top: 120, bottom: 180, height: 60, y: 120 }) as DOMRect;
    rerender(
      <TranscriptDocument
        activeSegmentId="seg-1"
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
      block: "center",
      behavior: "smooth",
    });
  });

  it("ignores pause gestures inside the horizontal segment rail", () => {
    function RailHarness() {
      return (
        <div className="media-transport__rail">
          <TranscriptDocument
            activeSegmentId="seg-1"
            editable={false}
            onSeek={vi.fn()}
            onUpdateSpeaker={vi.fn()}
            onUpdateText={vi.fn()}
            phoneSafetyMode={false}
            segments={baseSegments}
            summary="Ready for review."
            onSummaryChange={vi.fn()}
          />
        </div>
      );
    }
    const { rerender } = render(<RailHarness />);
    scrollIntoViewMock.mockClear();

    const rail = document.querySelector(".media-transport__rail")!;
    fireEvent(rail, new Event("wheel", { bubbles: true }));
    fireEvent.touchMove(rail);
    fireEvent.keyDown(rail, { key: "PageDown" });
    rerender(
      <div className="media-transport__rail">
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
        />
      </div>,
    );
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it("ignores pause gestures inside editors and sliders", () => {
    function EditorHarness({ activeSegmentId }: { activeSegmentId: string }) {
      return (
        <>
          <div aria-label="Playback scrubber" role="slider" tabIndex={0} />
          <TranscriptDocument
            activeSegmentId={activeSegmentId}
            editable
            onSeek={vi.fn()}
            onUpdateSpeaker={vi.fn()}
            onUpdateText={vi.fn()}
            phoneSafetyMode={false}
            segments={baseSegments}
            summary="Ready for review."
            onSummaryChange={vi.fn()}
          />
        </>
      );
    }

    const { rerender } = render(<EditorHarness activeSegmentId="seg-1" />);
    scrollIntoViewMock.mockClear();

    fireEvent.wheel(
      screen.getByRole("textbox", { name: "Transcript for segment 1, 00:00-00:10" }),
    );
    fireEvent.touchMove(screen.getByRole("slider", { name: "Playback scrubber" }));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Speaker for segment 1, 00:00-00:10" }),
      { key: "PageDown" },
    );
    rerender(<EditorHarness activeSegmentId="seg-2" />);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it("captures page-scroll keys before descendants stop propagation", () => {
    function CaptureHarness({ activeSegmentId }: { activeSegmentId: string }) {
      return (
        <div onKeyDown={(event) => event.stopPropagation()}>
          <button type="button">Manual page scroll</button>
          <TranscriptDocument
            activeSegmentId={activeSegmentId}
            editable={false}
            onSeek={vi.fn()}
            onUpdateSpeaker={vi.fn()}
            onUpdateText={vi.fn()}
            phoneSafetyMode={false}
            segments={baseSegments}
            summary="Ready for review."
            onSummaryChange={vi.fn()}
          />
        </div>
      );
    }

    const { rerender } = render(<CaptureHarness activeSegmentId="seg-1" />);
    scrollIntoViewMock.mockClear();

    fireEvent.keyDown(screen.getByRole("button", { name: "Manual page scroll" }), {
      key: "PageDown",
    });
    rerender(<CaptureHarness activeSegmentId="seg-2" />);

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("re-engages follow immediately on an explicit timestamp seek", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    const { rerender } = render(
      <TranscriptDocument
        activeSegmentId="seg-1"
        editable={false}
        onSeek={onSeek}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );
    scrollIntoViewMock.mockClear();

    fireEvent(window, new Event("wheel"));
    await user.click(screen.getByRole("button", { name: "Play from 00:10-00:20" }));
    expect(onSeek).toHaveBeenCalledWith(10_000);

    rerender(
      <TranscriptDocument
        activeSegmentId="seg-2"
        editable={false}
        onSeek={onSeek}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
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

  it("centers repeat locates and focuses the segment review affordance", () => {
    reducedMotion = true;
    const { rerender } = render(
      <TranscriptDocument
        activeSegmentId="seg-2"
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
      block: "center",
      behavior: "auto",
    });
    expect(
      screen.getByRole("textbox", { name: "Transcript for segment 2, 00:10-00:20" }),
    ).toHaveFocus();

    scrollIntoViewMock.mockClear();
    rerender(
      <TranscriptDocument
        activeSegmentId="seg-2"
        editable
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        reviewFocus={{ segmentId: "seg-2", nonce: 2 }}
        segments={baseSegments}
        summary="Ready for review."
        onSummaryChange={vi.fn()}
      />,
    );

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "center",
      behavior: "auto",
    });
    expect(
      screen.getByRole("textbox", { name: "Transcript for segment 2, 00:10-00:20" }),
    ).toHaveFocus();
  });

  it("flags segments edited versus the parent revision (demo-governance-bringback)", () => {
    render(
      <TranscriptDocument
        activeSegmentId={null}
        editable
        onSeek={vi.fn()}
        onUpdateSpeaker={vi.fn()}
        onUpdateText={vi.fn()}
        phoneSafetyMode={false}
        segments={baseSegments}
        summary="Updated wording."
        onSummaryChange={vi.fn()}
        diffHighlight={{ parentVersion: 2, editedSegmentIds: ["seg-2"] }}
      />,
    );

    const flags = screen.getAllByText("Edited vs v2");
    expect(flags).toHaveLength(1);
    expect(
      screen.getByRole("article", { name: /Transcript segment 2/i }),
    ).toHaveAttribute("data-edited-diff", "true");
    expect(
      screen.getByRole("article", { name: /Transcript segment 1/i }),
    ).not.toHaveAttribute("data-edited-diff");
  });
});
