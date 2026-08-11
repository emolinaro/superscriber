// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSegments } from "./test-fixtures";
import { MediaTransport } from "./media-transport";

describe("MediaTransport", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders native controls, jump back 10 seconds, playback rate, and current segment label", async () => {
    const user = userEvent.setup();
    render(
      <MediaTransport
        activeSegmentId="seg-2"
        mediaKind="audio"
        mediaUrl="/api/media/rec-1"
        onActiveSegmentChange={() => undefined}
        onSeekHandled={() => undefined}
        seekRequestMs={null}
        segments={baseSegments}
      />,
    );

    expect(screen.getByRole("group", { name: "Recording playback" })).toBeVisible();
    expect(document.querySelector("audio[controls]")).not.toBeNull();
    // Play/Pause toggle (restored after the stock controls were dropped for the wave player)
    const toggle = screen.getByTestId("transport-play-toggle");
    expect(toggle).toBeVisible();
    expect(toggle).toHaveTextContent("Play");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Jump back 10 seconds" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Playback rate"), "1.5");
    expect(screen.getByLabelText("Playback rate")).toHaveValue("1.5");
    expect(screen.getByText("Current segment: 2 - 00:10-00:20")).toBeVisible();
  });

  it("renders a segment rail whose chips seek the media and report the located segment", async () => {
    const user = userEvent.setup();
    const onLocateSegment = vi.fn();
    const onActiveSegmentChange = vi.fn();
    render(
      <MediaTransport
        activeSegmentId={null}
        mediaKind="audio"
        mediaUrl="/api/media/rec-1"
        onActiveSegmentChange={onActiveSegmentChange}
        onLocateSegment={onLocateSegment}
        onSeekHandled={() => undefined}
        seekRequestMs={null}
        segments={baseSegments}
      />,
    );

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    audio!.play = () => Promise.resolve();

    const rail = screen.getByRole("list", { name: "Transcript segments" });
    expect(rail).toBeVisible();
    const chips = screen.getAllByRole("button", { name: /Seek and review\./ });
    expect(chips).toHaveLength(2);

    await user.click(chips[1]);
    expect(audio!.currentTime).toBe(10);
    expect(onActiveSegmentChange).toHaveBeenCalledWith("seg-2");
    expect(onLocateSegment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "seg-2", startMs: 10_000 }),
    );
  });

  it("replaces transport with one denial reason when media is unavailable", () => {
    render(
      <MediaTransport
        activeSegmentId={null}
        mediaKind="audio"
        mediaUrl={null}
        mediaDenialReason="Media playback is denied for this role under the current policy."
        onActiveSegmentChange={() => undefined}
        onSeekHandled={() => undefined}
        seekRequestMs={null}
        segments={baseSegments}
      />,
    );

    expect(screen.getByText("Media playback is denied for this role under the current policy.")).toBeVisible();
    expect(document.querySelector("audio, video")).toBeNull();
  });
});
