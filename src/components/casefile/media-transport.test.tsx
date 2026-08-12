// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baseSegments } from "./test-fixtures";
import { MediaTransport } from "./media-transport";

function stubMediaPlayback(media: HTMLMediaElement) {
  let isPlaying = false;
  const play = vi.fn(() => {
    isPlaying = true;
    media.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.fn(() => {
    isPlaying = false;
    media.dispatchEvent(new Event("pause"));
  });
  Object.defineProperty(media, "paused", { configurable: true, get: () => !isPlaying });
  Object.defineProperty(media, "ended", { configurable: true, get: () => false });
  media.play = play as unknown as () => Promise<void>;
  media.pause = pause;
  return { play, pause };
}

describe("MediaTransport", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--player-clearance");
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
        seekRequest={null}
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
        seekRequest={null}
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

  it("syncs every seek target before resuming follow and ignores seeked", () => {
    const onMediaSeek = vi.fn();
    const onActiveSegmentChange = vi.fn();
    render(
      <MediaTransport
        onMediaSeek={onMediaSeek}
        activeSegmentId={null}
        mediaKind="audio"
        mediaUrl="/api/media/rec-1"
        onActiveSegmentChange={onActiveSegmentChange}
        onSeekHandled={() => undefined}
        seekRequest={null}
        segments={baseSegments}
      />,
    );

    const audio = document.querySelector("audio")!;
    audio.currentTime = 10;
    fireEvent(audio, new Event("seeking"));
    audio.currentTime = 1;
    fireEvent(audio, new Event("seeking"));
    fireEvent(audio, new Event("seeked"));
    audio.currentTime = 10;
    fireEvent(audio, new Event("seeking"));

    expect(onMediaSeek).toHaveBeenCalledTimes(3);
    expect(onActiveSegmentChange).toHaveBeenCalledWith("seg-1");
    expect(onActiveSegmentChange).toHaveBeenCalledWith("seg-2");
    for (let index = 0; index < 3; index += 1) {
      expect(onActiveSegmentChange.mock.invocationCallOrder[index]).toBeLessThan(
        onMediaSeek.mock.invocationCallOrder[index],
      );
    }
  });

  it("publishes the rendered transport height as player clearance", () => {
    let resizeCallback: ResizeObserverCallback = () => undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
      },
    );

    const { container } = render(
      <div className="casefile-page">
        <MediaTransport
          activeSegmentId={null}
          mediaKind="audio"
          mediaUrl="/api/media/rec-1"
          onActiveSegmentChange={() => undefined}
          onSeekHandled={() => undefined}
          seekRequest={null}
          segments={baseSegments}
        />
      </div>,
    );

    const page = container.querySelector<HTMLElement>(".casefile-page")!;
    const transport = container.querySelector<HTMLElement>(".media-transport")!;
    transport.getBoundingClientRect = () =>
      ({ height: 287, width: 800 } as DOMRect);
    resizeCallback([], {} as ResizeObserver);

    expect(observe).toHaveBeenCalledWith(transport);
    expect(page.style.getPropertyValue("--player-clearance")).toBe("287px");
    expect(
      document.documentElement.style.getPropertyValue("--player-clearance"),
    ).toBe("287px");
    expect(disconnect).not.toHaveBeenCalled();
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
        seekRequest={null}
        segments={baseSegments}
      />,
    );

    expect(screen.getByText("Media playback is denied for this role under the current policy.")).toBeVisible();
    expect(document.querySelector("audio, video")).toBeNull();
  });

  it("seek request for a non-active segment keeps the seek-and-play contract", () => {
    const onSeekHandled = vi.fn();
    const onActiveSegmentChange = vi.fn();
    const props = {
      activeSegmentId: "seg-1",
      mediaKind: "audio" as const,
      mediaUrl: "/api/media/rec-1",
      onActiveSegmentChange,
      onSeekHandled,
      segments: baseSegments,
    };
    const { rerender } = render(<MediaTransport {...props} seekRequest={null} />);

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    const stub = stubMediaPlayback(audio!);

    rerender(
      <MediaTransport
        {...props}
        seekRequest={{ segmentId: "seg-2", startMs: 10_000, endMs: 20_000 }}
      />,
    );

    expect(audio!.currentTime).toBe(10);
    expect(stub.play).toHaveBeenCalledTimes(1);
    expect(onActiveSegmentChange).toHaveBeenCalledWith("seg-2");
    expect(onSeekHandled).toHaveBeenCalledTimes(1);
  });

  it("seeks overlapping non-active segments using canonical ownership", () => {
    const onSeekHandled = vi.fn();
    const onActiveSegmentChange = vi.fn();
    const overlappingSegments = [
      { ...baseSegments[0], endMs: 20_000 },
      { ...baseSegments[1], startMs: 10_000, endMs: 30_000 },
    ];
    const props = {
      activeSegmentId: "seg-1",
      mediaKind: "audio" as const,
      mediaUrl: "/api/media/rec-1",
      onActiveSegmentChange,
      onSeekHandled,
      segments: overlappingSegments,
    };
    const { rerender } = render(<MediaTransport {...props} seekRequest={null} />);

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    const stub = stubMediaPlayback(audio!);
    audio!.currentTime = 15;

    rerender(
      <MediaTransport
        {...props}
        seekRequest={{ segmentId: "seg-2", startMs: 10_000, endMs: 30_000 }}
      />,
    );

    expect(audio!.currentTime).toBe(10);
    expect(stub.play).toHaveBeenCalledTimes(1);
    expect(stub.pause).not.toHaveBeenCalled();
    expect(onActiveSegmentChange).toHaveBeenCalledWith("seg-1");
    expect(onSeekHandled).toHaveBeenCalledTimes(1);
  });

  it("seeks after a save resets the active id away from the paused position", () => {
    const onSeekHandled = vi.fn();
    const onActiveSegmentChange = vi.fn();
    const props = {
      activeSegmentId: "seg-1",
      mediaKind: "audio" as const,
      mediaUrl: "/api/media/rec-1",
      onActiveSegmentChange,
      onSeekHandled,
      segments: baseSegments,
    };
    const { rerender } = render(<MediaTransport {...props} seekRequest={null} />);

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    const stub = stubMediaPlayback(audio!);
    audio!.currentTime = 15;

    rerender(
      <MediaTransport
        {...props}
        seekRequest={{ segmentId: "seg-1", startMs: 0, endMs: 10_000 }}
      />,
    );

    expect(audio!.currentTime).toBe(0);
    expect(stub.play).toHaveBeenCalledTimes(1);
    expect(stub.pause).not.toHaveBeenCalled();
    expect(onActiveSegmentChange).toHaveBeenCalledWith("seg-1");
    expect(onSeekHandled).toHaveBeenCalledTimes(1);
  });

  it("resumes the paused segment when a save leaves its active id stale", async () => {
    const onSeekHandled = vi.fn();
    const props = {
      activeSegmentId: "seg-1",
      mediaKind: "audio" as const,
      mediaUrl: "/api/media/rec-1",
      onActiveSegmentChange: vi.fn(),
      onSeekHandled,
      segments: baseSegments,
    };
    const { rerender } = render(<MediaTransport {...props} seekRequest={null} />);

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    const stub = stubMediaPlayback(audio!);
    audio!.currentTime = 15;

    rerender(
      <MediaTransport
        {...props}
        seekRequest={{ segmentId: "seg-2", startMs: 10_000, endMs: 20_000 }}
      />,
    );

    expect(stub.play).toHaveBeenCalledTimes(1);
    expect(stub.pause).not.toHaveBeenCalled();
    expect(audio!.currentTime).toBe(15);
    expect(onSeekHandled).toHaveBeenCalledTimes(1);
    expect(props.onActiveSegmentChange).toHaveBeenCalledWith("seg-2");
    await waitFor(() =>
      expect(screen.getByTestId("transport-play-toggle")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("seek request for the playing active segment pauses without re-seeking", async () => {
    const onSeekHandled = vi.fn();
    const onPlayingChange = vi.fn();
    const props = {
      activeSegmentId: "seg-1",
      mediaKind: "audio" as const,
      mediaUrl: "/api/media/rec-1",
      onActiveSegmentChange: () => undefined,
      onPlayingChange,
      onSeekHandled,
      segments: baseSegments,
    };
    const { rerender } = render(<MediaTransport {...props} seekRequest={null} />);

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    const stub = stubMediaPlayback(audio!);
    audio!.currentTime = 5;
    void audio!.play();

    const toggle = screen.getByTestId("transport-play-toggle");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));

    rerender(
      <MediaTransport
        {...props}
        seekRequest={{ segmentId: "seg-1", startMs: 0, endMs: 10_000 }}
      />,
    );

    // Pause is the equivalent of the transport pause button: no play() call,
    // no currentTime write, exposed state flips to paused on both controls.
    expect(stub.pause).toHaveBeenCalledTimes(1);
    expect(stub.play).toHaveBeenCalledTimes(1);
    expect(audio!.currentTime).toBe(5);
    expect(onSeekHandled).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(toggle).toHaveTextContent("Play");
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it("seek request for the paused active segment resumes from the paused position", async () => {
    const onSeekHandled = vi.fn();
    const props = {
      activeSegmentId: "seg-1",
      mediaKind: "audio" as const,
      mediaUrl: "/api/media/rec-1",
      onActiveSegmentChange: () => undefined,
      onSeekHandled,
      segments: baseSegments,
    };
    const { rerender } = render(<MediaTransport {...props} seekRequest={null} />);

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    const stub = stubMediaPlayback(audio!);
    audio!.currentTime = 5;

    rerender(
      <MediaTransport
        {...props}
        seekRequest={{ segmentId: "seg-1", startMs: 0, endMs: 10_000 }}
      />,
    );

    // Resume plays without touching currentTime: no audible/visible re-seek
    // jump back to the segment start.
    expect(stub.play).toHaveBeenCalledTimes(1);
    expect(stub.pause).not.toHaveBeenCalled();
    expect(audio!.currentTime).toBe(5);
    expect(onSeekHandled).toHaveBeenCalledTimes(1);
    const toggle = screen.getByTestId("transport-play-toggle");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(toggle).toHaveTextContent("Pause");
  });

  it("keeps the Space key toggling the transport play/pause button (keyboard parity)", async () => {
    const user = userEvent.setup();
    render(
      <MediaTransport
        activeSegmentId="seg-1"
        mediaKind="audio"
        mediaUrl="/api/media/rec-1"
        onActiveSegmentChange={() => undefined}
        onSeekHandled={() => undefined}
        seekRequest={null}
        segments={baseSegments}
      />,
    );

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    const stub = stubMediaPlayback(audio!);

    const toggle = screen.getByTestId("transport-play-toggle");
    toggle.focus();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.keyboard(" ");
    expect(stub.play).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(toggle).toHaveTextContent("Pause");

    await user.keyboard(" ");
    expect(stub.pause).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(toggle).toHaveTextContent("Play");
  });
});
