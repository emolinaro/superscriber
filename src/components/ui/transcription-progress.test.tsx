// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TranscriptionProgressBar } from "./transcription-progress";

afterEach(() => {
  cleanup();
});

describe("TranscriptionProgressBar", () => {
  it("renders the derived percent with segment and clock cues", () => {
    render(
      <TranscriptionProgressBar
        audioDurationMs={60_000}
        percent={41}
        segmentsSeen={7}
        transcribedUntilMs={25_000}
      />,
    );

    const bar = screen.getByRole("progressbar", { name: "Transcription progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "41");
    expect(bar).toHaveAttribute("data-live", "true");
    expect(screen.getByText("Transcribing 41%")).toBeVisible();
    expect(screen.getByText(/Segment 7/)).toBeVisible();
    expect(screen.getByText(/0:25 of 1:00/)).toBeVisible();
  });

  it("shows a liveness pulse instead of a fabricated fill while no engine sample exists", () => {
    render(<TranscriptionProgressBar percent={null} />);

    const bar = screen.getByRole("progressbar", { name: "Transcription progress" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("data-live", "warming");
    expect(bar.querySelector(".tp-progress__pulse")).not.toBeNull();
    expect(screen.getByText(/engine warming up/)).toBeVisible();
  });

  it("clamps out-of-range percents into the bar contract", () => {
    render(<TranscriptionProgressBar percent={140} />);

    expect(screen.getByRole("progressbar", { name: "Transcription progress" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });

  it("keeps the clock cue hidden until both ms values are known", () => {
    render(
      <TranscriptionProgressBar
        audioDurationMs={null}
        percent={8}
        segmentsSeen={1}
        transcribedUntilMs={5_000}
      />,
    );

    expect(screen.getByText(/Segment 1/)).toBeVisible();
    expect(screen.queryByText(/of /)).not.toBeInTheDocument();
  });
});
