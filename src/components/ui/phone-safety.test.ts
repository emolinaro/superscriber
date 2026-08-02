// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPhoneSafetyMode, usePhoneSafetyMode } from "./phone-safety";

type MatchMediaController = {
  setMatches: (matches: boolean) => void;
  restore: () => void;
};

function mockMatchMedia(initialMatches: boolean): MatchMediaController {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const original = window.matchMedia;
  let matches = initialMatches;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      media: query,
      matches,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    })),
  });

  return {
    setMatches(nextMatches) {
      matches = nextMatches;
      listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent));
    },
    restore() {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPhoneSafetyMode", () => {
  it("classifies portrait, landscape, and tablet cases exactly", () => {
    expect(isPhoneSafetyMode({ width: 390, height: 844, coarsePointer: true })).toBe(true);
    expect(isPhoneSafetyMode({ width: 844, height: 390, coarsePointer: true })).toBe(true);
    expect(isPhoneSafetyMode({ width: 1024, height: 768, coarsePointer: true })).toBe(false);
    expect(isPhoneSafetyMode({ width: 800, height: 640, coarsePointer: false })).toBe(false);
  });
});

describe("usePhoneSafetyMode", () => {
  it("stays true until client classification completes, then reacts to resize and pointer changes", async () => {
    setViewport(1024, 900);
    const matchMedia = mockMatchMedia(false);

    const { result } = renderHook(() => usePhoneSafetyMode());

    expect(result.current).toBe(true);
    await waitFor(() => {
      expect(result.current).toBe(false);
    });

    setViewport(700, 900);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    setViewport(1024, 900);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => {
      expect(result.current).toBe(false);
    });

    setViewport(1024, 640);
    matchMedia.setMatches(true);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    matchMedia.restore();
  });
});
