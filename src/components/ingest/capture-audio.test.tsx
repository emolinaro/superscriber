// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureAudio } from "./capture-audio";

type MediaRecorderListener = (event?: Event & { data?: Blob }) => void;

type RecorderController = {
  restore: () => void;
  setGetUserMediaResult: (mode: "resolve" | "reject") => void;
};

function installRecorderMocks(): RecorderController {
  const originalMediaRecorder = window.MediaRecorder;
  const originalMediaDevices = navigator.mediaDevices;
  const listeners = new Map<string, Set<MediaRecorderListener>>();
  let getUserMediaMode: "resolve" | "reject" = "resolve";

  class MockMediaRecorder {
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";

    addEventListener(type: string, listener: MediaRecorderListener) {
      const current = listeners.get(type) ?? new Set<MediaRecorderListener>();
      current.add(listener);
      listeners.set(type, current);
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      listeners.get("dataavailable")?.forEach((listener) => {
        listener({ data: new Blob(["captured-audio"], { type: "audio/webm" }) } as Event & {
          data: Blob;
        });
      });
      listeners.get("stop")?.forEach((listener) => {
        listener(new Event("stop"));
      });
    }
  }

  Object.defineProperty(window, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: MockMediaRecorder,
  });

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockImplementation(async () => {
        if (getUserMediaMode === "reject") {
          throw new Error("Permission denied");
        }

        return {
          getTracks: () => [{ stop: vi.fn() }],
        } as unknown as MediaStream;
      }),
    },
  });

  return {
    restore() {
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        writable: true,
        value: originalMediaRecorder,
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices,
      });
    },
    setGetUserMediaResult(mode) {
      getUserMediaMode = mode;
    },
  };
}

describe("CaptureAudio", () => {
  const onRecordingReady = vi.fn();
  const onRecordingCleared = vi.fn();
  let controller: RecorderController;

  beforeEach(() => {
    controller = installRecorderMocks();
    onRecordingReady.mockReset();
    onRecordingCleared.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn().mockReturnValue("blob:recording-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    controller.restore();
    vi.restoreAllMocks();
  });

  it("renders an unsupported fallback when browser recording is unavailable", () => {
    controller.restore();
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    render(
      <CaptureAudio
        disabled={false}
        onRecordingCleared={onRecordingCleared}
        onRecordingReady={onRecordingReady}
      />,
    );

    expect(screen.getByText("Browser recording is not available in this browser.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start recording" })).not.toBeInTheDocument();
  });

  it("replaces controls with a focused assertive notice after microphone denial", async () => {
    const user = userEvent.setup();
    controller.setGetUserMediaResult("reject");

    render(
      <CaptureAudio
        disabled={false}
        onRecordingCleared={onRecordingCleared}
        onRecordingReady={onRecordingReady}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start recording" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(
      "Microphone access was blocked. Choose Upload file to continue safely.",
    );
    await waitFor(() => {
      expect(notice).toHaveFocus();
    });
    expect(screen.queryByRole("button", { name: "Start recording" })).not.toBeInTheDocument();
  });

  it("supports stop, preview, and replace controls with 44 px target hooks", async () => {
    const user = userEvent.setup();

    render(
      <CaptureAudio
        disabled={false}
        onRecordingCleared={onRecordingCleared}
        onRecordingReady={onRecordingReady}
      />,
    );

    const start = screen.getByRole("button", { name: "Start recording" });
    expect(start).toHaveClass("interactive-target");

    await user.click(start);

    const stop = screen.getByRole("button", { name: "Stop recording" });
    expect(stop).toHaveClass("interactive-target");
    await user.click(stop);

    await waitFor(() => {
      expect(onRecordingReady).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByLabelText("Recorded audio preview")).toBeVisible();
    expect(screen.getByRole("button", { name: "Replace recording" })).toHaveClass(
      "interactive-target",
    );

    await user.click(screen.getByRole("button", { name: "Replace recording" }));

    expect(onRecordingCleared).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Recorded audio preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeVisible();
  });
});
