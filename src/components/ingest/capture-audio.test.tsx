// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureAudio } from "./capture-audio";

type MediaRecorderListener = (event?: Event & { data?: Blob }) => void;

type RecorderInstance = {
  state: "inactive" | "recording" | "paused";
  startCalls: number;
  pauseCalls: number;
  resumeCalls: number;
  stopCalls: number;
  stopEvents: number;
};

type MockTrack = {
  readyState: "live" | "ended";
  stop: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

type RecorderController = {
  restore: () => void;
  setGetUserMediaResult: (mode: "resolve" | "reject") => void;
  failRecorderMethod: (method: "pause" | "resume" | null) => void;
  recorderInstances: () => RecorderInstance[];
  tracks: () => MockTrack[];
  emitTrackEnded: () => void;
};

function installRecorderMocks(): RecorderController {
  const originalMediaRecorder = window.MediaRecorder;
  const originalMediaDevices = navigator.mediaDevices;
  let getUserMediaMode: "resolve" | "reject" = "resolve";
  let failingMethod: "pause" | "resume" | null = null;
  const instances: RecorderInstance[] = [];
  const createdTracks: MockTrack[] = [];
  const endedListeners = new Set<() => void>();

  class MockMediaRecorder {
    state: "inactive" | "recording" | "paused" = "inactive";
    mimeType = "audio/webm";
    startCalls = 0;
    pauseCalls = 0;
    resumeCalls = 0;
    stopCalls = 0;
    stopEvents = 0;
    private listeners = new Map<string, Set<MediaRecorderListener>>();

    constructor() {
      instances.push(this);
    }

    addEventListener(type: string, listener: MediaRecorderListener) {
      const current = this.listeners.get(type) ?? new Set<MediaRecorderListener>();
      current.add(listener);
      this.listeners.set(type, current);
    }

    start() {
      if (this.state !== "inactive") {
        throw new Error("InvalidStateError: recorder is already started");
      }
      this.startCalls += 1;
      this.state = "recording";
    }

    pause() {
      this.pauseCalls += 1;
      if (this.state !== "recording" || failingMethod === "pause") {
        throw new Error("InvalidStateError: recorder is not recording");
      }
      this.state = "paused";
    }

    resume() {
      this.resumeCalls += 1;
      if (this.state !== "paused" || failingMethod === "resume") {
        throw new Error("InvalidStateError: recorder is not paused");
      }
      this.state = "recording";
    }

    stop() {
      this.stopCalls += 1;
      if (this.state === "inactive") {
        throw new Error("InvalidStateError: recorder is inactive");
      }
      this.state = "inactive";
      this.listeners.get("dataavailable")?.forEach((listener) => {
        listener({ data: new Blob(["captured-audio"], { type: "audio/webm" }) } as Event & {
          data: Blob;
        });
      });
      this.listeners.get("stop")?.forEach((listener) => {
        listener(new Event("stop"));
      });
      this.stopEvents += 1;
    }
  }

  function createStream() {
    const track: MockTrack = {
      readyState: "live",
      stop: vi.fn(() => {
        track.readyState = "ended";
      }),
      addEventListener: (type, listener) => {
        if (type === "ended") {
          endedListeners.add(listener);
        }
      },
      removeEventListener: (type, listener) => {
        if (type === "ended") {
          endedListeners.delete(listener);
        }
      },
    };
    createdTracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
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

        return createStream();
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
    failRecorderMethod(method) {
      failingMethod = method;
    },
    recorderInstances() {
      return instances;
    },
    tracks() {
      return createdTracks;
    },
    emitTrackEnded() {
      endedListeners.forEach((listener) => listener());
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
    cleanup();
    controller.restore();
    vi.restoreAllMocks();
  });

  function renderCapture() {
    return render(
      <CaptureAudio
        disabled={false}
        onRecordingCleared={onRecordingCleared}
        onRecordingReady={onRecordingReady}
      />,
    );
  }

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

    renderCapture();

    expect(screen.getByText("Browser recording is not available in this browser.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start recording" })).not.toBeInTheDocument();
  });

  it("replaces controls with a focused assertive notice after microphone denial", async () => {
    const user = userEvent.setup();
    controller.setGetUserMediaResult("reject");

    renderCapture();

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

  it("supports stop, preview, and discard controls with 44 px target hooks", async () => {
    const user = userEvent.setup();

    renderCapture();

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
    expect(screen.getByRole("button", { name: "Discard" })).toHaveClass("interactive-target");

    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(onRecordingCleared).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Recorded audio preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("pauses and resumes one recorder instance in the current tab", async () => {
    const user = userEvent.setup();

    renderCapture();

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Pause recording" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Recording paused. This recording stays in this browser tab; reloading, navigating, or " +
        "switching source starts over. Resume to continue the same recording, or Stop to finish " +
        "and preview the audio already captured.",
    );
    expect(screen.getByRole("button", { name: "Resume recording" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Pause recording" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume recording" }));

    const instances = controller.recorderInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.startCalls).toBe(1);
    expect(instances[0]?.pauseCalls).toBe(1);
    expect(instances[0]?.resumeCalls).toBe(1);
    expect(instances[0]?.stopCalls).toBe(0);
    expect(screen.getByRole("status")).toHaveTextContent(/Recording in progress/);
    expect(screen.getByRole("button", { name: "Pause recording" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Resume recording" })).not.toBeInTheDocument();
    expect(onRecordingReady).not.toHaveBeenCalled();
  });

  it("stops directly from paused and delivers exactly one preview file", async () => {
    const user = userEvent.setup();

    renderCapture();

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Pause recording" }));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(onRecordingReady).toHaveBeenCalledTimes(1);
    });

    const instances = controller.recorderInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.stopEvents).toBe(1);
    expect(screen.getByLabelText("Recorded audio preview")).toBeVisible();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeDisabled();
  });

  it("emits onRecordingReady once when stop is activated repeatedly", async () => {
    const user = userEvent.setup();

    renderCapture();

    await user.click(screen.getByRole("button", { name: "Start recording" }));

    const stop = screen.getByRole("button", { name: "Stop recording" });
    await user.click(stop);
    fireEvent.click(stop);

    await waitFor(() => {
      expect(onRecordingReady).toHaveBeenCalledTimes(1);
    });

    const instances = controller.recorderInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.stopEvents).toBe(1);
  });
});
