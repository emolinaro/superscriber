// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(screen.getByRole("button", { name: "Jump back 10 seconds" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Playback rate"), "1.5");
    expect(screen.getByLabelText("Playback rate")).toHaveValue("1.5");
    expect(screen.getByText("Current segment: 2 - 00:10-00:20")).toBeVisible();
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
