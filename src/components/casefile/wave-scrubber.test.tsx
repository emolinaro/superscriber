// @vitest-environment jsdom

import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseSegments } from "./test-fixtures";
import { WaveScrubber } from "./wave-scrubber";

type FakeWaveSurfer = {
  listeners: Map<string, Array<(...args: number[]) => void>>;
  on: (event: string, listener: (...args: number[]) => void) => void;
  destroy: () => void;
};

const createdInstances: FakeWaveSurfer[] = [];

vi.mock("wavesurfer.js", () => ({
  default: {
    create: () => {
      const instance: FakeWaveSurfer = {
        listeners: new Map(),
        on: (event, listener) => {
          const list = instance.listeners.get(event) ?? [];
          list.push(listener);
          instance.listeners.set(event, list);
        },
        destroy: vi.fn(),
      };
      createdInstances.push(instance);
      return instance;
    },
  },
}));

function emit(instance: FakeWaveSurfer, event: string, ...args: number[]) {
  for (const listener of instance.listeners.get(event) ?? []) {
    listener(...args);
  }
}

describe("WaveScrubber", () => {
  beforeEach(() => {
    createdInstances.length = 0;
  });

  afterEach(() => {
    cleanup();
    // @ts-expect-error test teardown: restore the jsdom feature gap
    delete window.AudioContext;
  });

  it("reports unavailability and keeps the native-controls fallback where decoding is unsupported", () => {
    const onUnavailable = vi.fn();
    const onReady = vi.fn();
    render(
      <WaveScrubber
        activeSegmentId={null}
        media={document.createElement("audio")}
        mediaUrl="/api/media/rec-1"
        onReady={onReady}
        onSeekToSegment={() => undefined}
        onUnavailable={onUnavailable}
        segments={baseSegments}
      />,
    );

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(createdInstances).toHaveLength(0);
  });

  it("draws segment markers and a live band once the decoded wave is ready", async () => {
    class FakeAudioContext {}
    // @ts-expect-error test shim: feature-detect passed by the component
    window.AudioContext = FakeAudioContext;

    const onReady = vi.fn();
    const onSeekToSegment = vi.fn();
    render(
      <WaveScrubber
        activeSegmentId="seg-2"
        media={document.createElement("audio")}
        mediaUrl="/api/media/rec-1"
        onReady={onReady}
        onSeekToSegment={onSeekToSegment}
        onUnavailable={() => undefined}
        segments={baseSegments}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const instance = createdInstances[0];
    expect(instance).toBeDefined();

    act(() => {
      emit(instance, "ready", 40);
      emit(instance, "timeupdate", 12.4);
    });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wave-scrubber")).toHaveAttribute("data-ready", "true");

    const markers = screen.getAllByRole("button", { name: /Wave marker: segment/ });
    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveAttribute("style", expect.stringContaining("left: 0%"));
    expect(markers[1]).toHaveAttribute("style", expect.stringContaining("left: 25%"));

    const band = screen.getByTestId("wave-active-band");
    expect(band).toHaveAttribute(
      "style",
      expect.stringContaining("left: 25%"),
    );
    expect(band).toHaveAttribute(
      "style",
      expect.stringContaining("width: 25%"),
    );

    expect(screen.getByTestId("wave-timecode")).toHaveTextContent("00:12.4");

    act(() => {
      markers[1].click();
    });
    expect(onSeekToSegment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "seg-2", startMs: 10_000 }),
    );
  });
});
