// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let railScrollToMock: ReturnType<typeof vi.fn>;
  let reducedMotion: boolean;

  beforeEach(() => {
    reducedMotion = false;
    // jsdom implements neither Element.scrollTo nor window.matchMedia; the
    // rail's horizontal follow (wave-track scroll sync) needs both.
    railScrollToMock = vi.fn();
    window.HTMLElement.prototype.scrollTo =
      railScrollToMock as unknown as HTMLElement["scrollTo"];
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe = (target: Element) => {
          observe(target);
          resizeCallbacks.set(target, this.callback);
        };
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
    resizeCallbacks.get(transport)!([], {} as ResizeObserver);

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

  describe("rail follow (wave-track scroll sync)", () => {
    const railSegments = Array.from({ length: 6 }, (_, index) => ({
      id: `rail-seg-${index + 1}`,
      speakerLabel: `Speaker ${index + 1}`,
      startMs: index * 10_000,
      endMs: (index + 1) * 10_000,
      text: `Line ${index + 1}.`,
      confidence: 0.9,
    }));
    // jsdom reports zero geometry, so chip/layout geometry is stubbed per
    // test: 200px chip stride, 176px chip width, 400px viewport.
    const railOffsets = railSegments.map((_, index) => index * 200);

    function railProps(segments = railSegments) {
      return {
        mediaKind: "audio" as const,
        mediaUrl: "/api/media/rec-1",
        onActiveSegmentChange: vi.fn(),
        onSeekHandled: vi.fn(),
        seekRequest: null,
        segments,
      };
    }

    function stubRailStrip(rail: HTMLElement) {
      let scrollLeft = 0;
      const offsets = [...railOffsets];
      const widths = railSegments.map(() => 176);
      Object.defineProperty(rail, "clientWidth", { configurable: true, value: 400 });
      Object.defineProperty(rail, "scrollLeft", {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => {
          scrollLeft = value;
        },
      });
      rail.getBoundingClientRect = () =>
        ({ left: 0, right: 400, width: 400 }) as DOMRect;
      rail
        .querySelectorAll<HTMLElement>(".media-transport__rail-chip")
        .forEach((chip, index) => {
          chip.getBoundingClientRect = () =>
            ({
              left: offsets[index] - scrollLeft,
              right: offsets[index] - scrollLeft + widths[index],
              width: widths[index],
            }) as DOMRect;
        });
      return {
        setChipGeometry(index: number, offsetLeft: number, width: number) {
          offsets[index] = offsetLeft;
          widths[index] = width;
        },
        setScrollLeft(value: number) {
          scrollLeft = value;
        },
      };
    }

    it("centers the active chip in the rail as playback advances past the scrollport edge", () => {
      const { container, rerender } = render(
        <MediaTransport {...railProps()} activeSegmentId="rail-seg-1" />,
      );
      // Geometry is stubbed after mount; the initial zero-geometry center
      // (scrollLeft 0 target) is not the assertion.
      stubRailStrip(container.querySelector<HTMLElement>(".media-transport__rail")!);
      railScrollToMock.mockClear();

      rerender(<MediaTransport {...railProps()} activeSegmentId="rail-seg-6" />);

      // Chip 6 spans content 1000-1176 in a 400px viewport: centered at 888.
      expect(railScrollToMock).toHaveBeenCalledWith({ left: 888, behavior: "smooth" });
    });

    it("recenters the active chip when a speaker rename changes rail geometry", () => {
      const renamedSegments = railSegments.map((segment, index) =>
        index === 1
          ? { ...segment, speakerLabel: "Speaker 2 with a substantially longer name" }
          : segment,
      );
      const { container, rerender } = render(
        <MediaTransport {...railProps()} activeSegmentId="rail-seg-6" />,
      );
      const strip = stubRailStrip(
        container.querySelector<HTMLElement>(".media-transport__rail")!,
      );
      railScrollToMock.mockClear();

      strip.setChipGeometry(5, 1120, 176);
      rerender(
        <MediaTransport
          {...railProps(renamedSegments)}
          activeSegmentId="rail-seg-6"
        />,
      );

      expect(railScrollToMock).toHaveBeenCalledWith({ left: 1008, behavior: "smooth" });
    });

    it("uses an instant follow scroll under prefers-reduced-motion", () => {
      reducedMotion = true;
      const { container, rerender } = render(
        <MediaTransport {...railProps()} activeSegmentId="rail-seg-1" />,
      );
      stubRailStrip(container.querySelector<HTMLElement>(".media-transport__rail")!);
      railScrollToMock.mockClear();

      rerender(<MediaTransport {...railProps()} activeSegmentId="rail-seg-6" />);

      expect(railScrollToMock).toHaveBeenCalledWith({ left: 888, behavior: "auto" });
    });

    it("recenters the active chip when the rail reappears at a new width", () => {
      let railResizeCallback: ResizeObserverCallback | null = null;
      const observe = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          callback: ResizeObserverCallback;

          constructor(callback: ResizeObserverCallback) {
            this.callback = callback;
          }

          observe = (target: Element) => {
            observe(target);
            if (target.classList.contains("media-transport__rail")) {
              railResizeCallback = this.callback;
            }
          };
          disconnect = vi.fn();
          unobserve = vi.fn();
        },
      );

      const { container } = render(
        <MediaTransport {...railProps()} activeSegmentId="rail-seg-6" />,
      );
      const rail = container.querySelector<HTMLElement>(".media-transport__rail")!;
      stubRailStrip(rail);
      railScrollToMock.mockClear();

      expect(observe).toHaveBeenCalledWith(rail);
      act(() => railResizeCallback!([], {} as ResizeObserver));

      expect(railScrollToMock).toHaveBeenCalledWith({ left: 888, behavior: "smooth" });
    });

    it("pauses its own follow on a rail gesture and resumes once the active chip is in view again", () => {
      const { container, rerender } = render(
        <MediaTransport {...railProps()} activeSegmentId="rail-seg-1" />,
      );
      const rail = container.querySelector<HTMLElement>(".media-transport__rail")!;
      const strip = stubRailStrip(rail);
      rerender(<MediaTransport {...railProps()} activeSegmentId="rail-seg-2" />);
      railScrollToMock.mockClear();

      // A user scroll gesture on the strip pauses ITS follow only.
      fireEvent(rail, new Event("wheel"));
      rerender(<MediaTransport {...railProps()} activeSegmentId="rail-seg-6" />);
      // Chip 6 (1000-1176) is out of the 0-400 view: leave the user alone.
      expect(railScrollToMock).not.toHaveBeenCalled();

      // Playback advances while the user has scrolled the strip so the new
      // active chip (600-776) intersects the 350-750 view: re-engage.
      strip.setScrollLeft(350);
      rerender(<MediaTransport {...railProps()} activeSegmentId="rail-seg-4" />);
      expect(railScrollToMock).toHaveBeenCalledWith({ left: 488, behavior: "smooth" });
    });

    it("re-engages paused follow immediately on an explicit media seek", () => {
      const onActiveSegmentChange = vi.fn();
      const { container, rerender } = render(
        <MediaTransport
          {...railProps()}
          activeSegmentId="rail-seg-1"
          onActiveSegmentChange={onActiveSegmentChange}
        />,
      );
      const rail = container.querySelector<HTMLElement>(".media-transport__rail")!;
      stubRailStrip(rail);
      railScrollToMock.mockClear();

      fireEvent(rail, new Event("wheel"));

      // A hard seek (wave click/drag, native controls, transcript timestamp)
      // re-engages the horizontal follow even though the user just scrolled.
      const audio = document.querySelector("audio")!;
      audio.currentTime = 45;
      fireEvent(audio, new Event("seeking"));
      expect(onActiveSegmentChange).toHaveBeenCalledWith("rail-seg-5");
      // The seek itself re-runs the follow against the still-current chip
      // (seg-1 is in view) ...
      expect(railScrollToMock).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
      railScrollToMock.mockClear();

      // ... and once the parent propagates the new active id, follow centers
      // the newly active chip even though it is far out of view - the pause
      // is gone, no visibility qualification.
      rerender(
        <MediaTransport
          {...railProps()}
          activeSegmentId="rail-seg-5"
          onActiveSegmentChange={onActiveSegmentChange}
        />,
      );
      expect(railScrollToMock).toHaveBeenCalledWith({ left: 688, behavior: "smooth" });
    });
  });
});
