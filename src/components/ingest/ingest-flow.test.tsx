// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRole } from "@/domain/models";
import { IngestFlow } from "./ingest-flow";

const { mockPush, mockRefresh } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

const { mockPhoneSafety } = vi.hoisted(() => ({
  mockPhoneSafety: { value: false },
}));

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => mockPhoneSafety.value,
}));

type UploadSessionStatus = {
  sessionId: string;
  recordingId: string;
  state: string;
  integrityState: string;
  bytesReceived: number;
  bytesExpected: number;
  progressPercent: number;
  resumeToken: string | null;
  nextAction: "resume" | "restart" | "finalize" | "none";
  verificationSummary: string | null;
  title: string;
  source: "upload" | "record";
  mediaPath: string | null;
  tempFilePresent: boolean;
  warning?: string | null;
};

const STABLE_UPLOAD_INTERRUPTION_RECOVERY_NOTICE =
  "Upload interrupted. Choose the same file again to resume safely.";

type MediaRecorderListener = (event?: Event & { data?: Blob }) => void;

function installRecorderSupport() {
  const instances: Array<{
    state: "inactive" | "recording" | "paused";
    startCalls: number;
    pauseCalls: number;
    resumeCalls: number;
  }> = [];

  class MockMediaRecorder {
    state: "inactive" | "recording" | "paused" = "inactive";
    mimeType = "audio/webm";
    startCalls = 0;
    pauseCalls = 0;
    resumeCalls = 0;
    private listeners = new Map<string, Set<MediaRecorderListener>>();

    constructor() {
      instances.push(this);
    }

    addEventListener(type: string, listener: MediaRecorderListener) {
      const current = this.listeners.get(type) ?? new Set<MediaRecorderListener>();
      current.add(listener);
      this.listeners.set(type, current);
    }

    removeEventListener(type: string, listener: MediaRecorderListener) {
      this.listeners.get(type)?.delete(listener);
    }

    start() {
      this.startCalls += 1;
      this.state = "recording";
    }

    pause() {
      this.pauseCalls += 1;
      if (this.state !== "recording") {
        throw new Error("InvalidStateError: recorder is not recording");
      }
      this.state = "paused";
    }

    resume() {
      this.resumeCalls += 1;
      if (this.state !== "paused") {
        throw new Error("InvalidStateError: recorder is not paused");
      }
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      this.listeners.get("dataavailable")?.forEach((listener) => {
        listener({ data: new Blob(["recorded-audio"], { type: "audio/webm" }) } as Event & {
          data: Blob;
        });
      });
      this.listeners.get("stop")?.forEach((listener) => {
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
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [
          { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
        ],
      }),
    },
  });

  return { instances };
}

function removeRecorderSupport() {
  Object.defineProperty(window, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
}

function createStorage() {
  const store = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">;
}

function buildStatus(overrides: Partial<UploadSessionStatus> = {}): UploadSessionStatus {
  return {
    sessionId: "session-1",
    recordingId: "recording-1",
    state: "uploading",
    integrityState: "uploading",
    bytesReceived: 0,
    bytesExpected: 6,
    progressPercent: 0,
    resumeToken: null,
    nextAction: "resume",
    verificationSummary: null,
    title: "Interview 001",
    source: "upload",
    mediaPath: null,
    tempFilePresent: true,
    warning: null,
    ...overrides,
  };
}

function attachFiles(input: HTMLInputElement, files: File[]) {
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* iterate() {
      yield* files;
    },
  } as FileList;
  files.forEach((file, index) => {
    Object.defineProperty(fileList, index, { configurable: true, value: file, enumerable: true });
  });
  Object.defineProperty(input, "files", { configurable: true, value: fileList });
  fireEvent.change(input);
}

function mockBatchServer({ failOn }: { failOn?: string } = {}) {
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    if (url === "/api/ingest/sessions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { fileName?: string; fileSize?: number };
      if (failOn && body.fileName === failOn) {
        return Promise.reject(new Error("Unsupported media type."));
      }
      return mockJsonResponse({
        ok: true,
        status: {
          sessionId: `s-${body.fileName}`,
          recordingId: "recording-1",
          nextAction: "upload",
          bytesReceived: 0,
          bytesExpected: body.fileSize ?? 0,
          progressPercent: 0,
          verificationSummary: null,
        },
      });
    }
    if (url.includes("/chunk")) {
      const start = Number((init?.headers as Record<string, string>)["x-superscriber-byte-start"]);
      const size = (init?.body as ArrayBuffer).byteLength;
      return mockJsonResponse({
        ok: true,
        status: {
          sessionId: "s-1",
          nextAction: "finalize",
          bytesReceived: start + size,
          bytesExpected: start + size,
          progressPercent: 100,
          verificationSummary: null,
        },
      });
    }
    if (url.includes("/finalize")) {
      return mockJsonResponse({
        ok: true,
        nextPath: "/recordings/recording-1",
        status: { sessionId: "s-1", nextAction: "done", progressPercent: 100 },
      });
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

function mockJsonResponse(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderFlow(role: Extract<UserRole, "uploader" | "admin"> = "uploader") {
  return render(<IngestFlow principalRole={role} />);
}

function renderFlowOnServer(role: Extract<UserRole, "uploader" | "admin"> = "uploader") {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;

  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "navigator");

  try {
    return renderToString(<IngestFlow principalRole={role} />);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("IngestFlow", () => {
  let recorderInstances: ReturnType<typeof installRecorderSupport>["instances"];

  beforeEach(() => {
    recorderInstances = installRecorderSupport().instances;
    mockPush.mockReset();
    mockRefresh.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn().mockReturnValue("blob:recording-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
    global.fetch = vi.fn();
  });

  it("abandons a completed take when switching away from Record audio", async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));
    await user.type(screen.getByLabelText("Title"), "Interview 011");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(await screen.findByLabelText("Recorded audio preview")).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /Upload file/ }));

    expect(screen.getByLabelText("Title")).toHaveValue("Interview 011");
    expect(screen.getByLabelText("Language")).toHaveValue("english");
    expect(screen.getByLabelText("Audio or video file")).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));

    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
    expect(screen.queryByLabelText("Recorded audio preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upload recording" }));

    const summary = await screen.findByRole("alert", { name: "There is a problem" });
    expect(summary).toHaveTextContent("Recording - Record audio before uploading.");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).startsWith("/api/ingest/sessions")),
    ).toHaveLength(0);
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });

  it("never delivers an in-progress take after switching sources mid-capture", async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));
    await user.type(screen.getByLabelText("Title"), "Interview 012");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Pause recording" }));

    await user.click(screen.getByRole("radio", { name: /Upload file/ }));
    await user.click(screen.getByRole("radio", { name: /Record audio/ }));

    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
    expect(screen.queryByLabelText("Recorded audio preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upload recording" }));

    const summary = await screen.findByRole("alert", { name: "There is a problem" });
    expect(summary).toHaveTextContent("Recording - Record audio before uploading.");
    expect(fetch).not.toHaveBeenCalled();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });

  it("keeps capture local until Upload recording creates the first durable session", async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));
    await user.type(screen.getByLabelText("Title"), "Interview 009");
    await user.selectOptions(screen.getByLabelText("Language"), "english");

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Pause recording" }));
    expect(screen.getByRole("button", { name: "Resume recording" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Resume recording" }));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(await screen.findByLabelText("Recorded audio preview")).toBeVisible();

    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).startsWith("/api/ingest/sessions")),
    ).toHaveLength(0);
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("superscriber.pendingIngest")).toBeNull();

    const recordedFileSize = 14;
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          status: buildStatus({ source: "record", bytesExpected: recordedFileSize }),
        }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          status: buildStatus({
            source: "record",
            bytesReceived: recordedFileSize,
            bytesExpected: recordedFileSize,
            progressPercent: 100,
            nextAction: "finalize",
          }),
        }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({
            source: "record",
            bytesReceived: recordedFileSize,
            bytesExpected: recordedFileSize,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
          }),
        }),
      );

    await user.click(screen.getByRole("button", { name: "Upload recording" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/workspace?notice=Upload+received.+Verification+has+started.",
      );
    });

    expect(recorderInstances).toHaveLength(1);
    expect(recorderInstances[0]?.startCalls).toBe(1);

    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => input === "/api/ingest/sessions");
    expect(createCall?.[1]?.method).toBe("POST");
    const createBody = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
    expect(createBody).toMatchObject({
      title: "Interview 009",
      languageHint: "english",
      source: "record",
      mimeType: "audio/webm",
      fileSize: recordedFileSize,
    });
    expect(String(createBody.fileName)).toMatch(/^recording-.*\.webm$/);

    const [, rawValue] = vi.mocked(window.localStorage.setItem).mock.calls[0] ?? [];
    expect(JSON.parse(String(rawValue))).toMatchObject({
      sessionId: "session-1",
      fileName: createBody.fileName,
      fileSize: recordedFileSize,
      fileType: "audio/webm",
      source: "record",
    });
    expect(String(rawValue)).not.toContain("Interview 009");
    expect(String(rawValue)).not.toContain("english");
    expect(window.localStorage.getItem("superscriber.pendingIngest")).toBeNull();
  });

  it("blocks upload of a discarded take and supports an immediate re-record", async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));
    await user.type(screen.getByLabelText("Title"), "Interview 010");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(await screen.findByLabelText("Recorded audio preview")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.queryByLabelText("Recorded audio preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Upload recording" }));

    const summary = await screen.findByRole("alert", { name: "There is a problem" });
    expect(summary).toHaveTextContent("Recording - Record audio before uploading.");
    expect(fetch).not.toHaveBeenCalled();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();

    const recordedFileSize = 14;
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          status: buildStatus({ source: "record", bytesExpected: recordedFileSize }),
        }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          status: buildStatus({
            source: "record",
            bytesReceived: recordedFileSize,
            bytesExpected: recordedFileSize,
            progressPercent: 100,
            nextAction: "finalize",
          }),
        }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({
            source: "record",
            bytesReceived: recordedFileSize,
            bytesExpected: recordedFileSize,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
          }),
        }),
      );

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(await screen.findByLabelText("Recorded audio preview")).toBeVisible();
    expect(recorderInstances).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Upload recording" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/workspace?notice=Upload+received.+Verification+has+started.",
      );
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => input === "/api/ingest/sessions"),
    ).toHaveLength(1);
  });

  it("renders Source as a native radio group and validates title, language, and upload file", async () => {
    const user = userEvent.setup();
    renderFlow();

    expect(screen.getByRole("group", { name: "Source" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Upload file/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Record audio/ })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Upload file" }));

    const summary = await screen.findByRole("alert", { name: "There is a problem" });
    expect(summary).toHaveTextContent("Title - Enter a title between 1 and 120 characters.");
    expect(summary).toHaveTextContent("Language - Choose a language.");
    expect(summary).toHaveTextContent("File - Choose a file to upload.");

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "x".repeat(121) },
    });
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("Enter a title between 1 and 120 characters.")).toBeVisible();
  });

  it("shows only Upload when browser recording is unsupported", () => {
    removeRecorderSupport();
    renderFlow();

    expect(screen.getByRole("radio", { name: /Upload file/ })).toBeVisible();
    expect(screen.queryByRole("radio", { name: /Record audio/ })).not.toBeInTheDocument();
  });

  it("hydrates the upload source before revealing browser recording support", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const serverHtml = renderFlowOnServer();
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = serverHtml;

    expect(container).toHaveTextContent("Upload file");
    expect(container).not.toHaveTextContent("Record audio");

    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <IngestFlow principalRole="uploader" />);
      await Promise.resolve();
    });

    const consoleMessages = consoleError.mock.calls
      .map((call) => call.map((part) => String(part)).join(" "))
      .join("\n");

    expect(consoleMessages).not.toMatch(/Hydration failed|did not match/i);
    expect(screen.getByRole("radio", { name: /Upload file/ })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /Record audio/ })).toBeVisible();
    });

    root.unmount();
  });

  it("keeps Upload selectable after microphone denial", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error("Permission denied")),
      },
    });

    renderFlow();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(
      "Microphone access was blocked. Choose Upload file to continue safely.",
    );

    await user.click(screen.getByRole("radio", { name: /Upload file/ }));
    expect(screen.getByLabelText("Audio or video file")).toBeVisible();
  });

  it("writes only safe metadata when creating a session", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 1234,
    });

    vi.mocked(fetch)
      .mockImplementationOnce(() => mockJsonResponse({ ok: true, status: buildStatus() }))
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }) }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({
            bytesReceived: 6,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
            warning: null,
          }),
        }),
      );

    renderFlow();

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(window.localStorage.setItem).toHaveBeenCalled();
    });

    const [, rawValue] = vi.mocked(window.localStorage.setItem).mock.calls[0] ?? [];
    expect(JSON.parse(String(rawValue))).toEqual({
      sessionId: "session-1",
      fileName: "clip.wav",
      fileSize: 6,
      fileType: "audio/wav",
      fileLastModified: 1234,
      source: "upload",
    });
    expect(String(rawValue)).not.toContain("Interview 001");
    expect(String(rawValue)).not.toContain("english");
  });

  it("resumes from committed bytes for the same file and finalizes when bytes complete", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 1234,
    });

    window.localStorage.setItem(
      "superscriber.pendingIngest",
      JSON.stringify({
        sessionId: "session-1",
        fileName: "clip.wav",
        fileSize: 6,
        fileType: "audio/wav",
        fileLastModified: 1234,
        source: "upload",
      }),
    );

    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ bytesReceived: 3, progressPercent: 50 }) }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ bytesReceived: 3, progressPercent: 50 }) }),
      )
      .mockImplementationOnce((input, init) => {
        expect(String(input)).toContain("/api/ingest/sessions/session-1/chunk");
        expect((init?.headers as Record<string, string>)["x-superscriber-byte-start"]).toBe("3");
        expect(init?.method).toBe("PUT");
        return mockJsonResponse({
          ok: true,
          status: buildStatus({ bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }),
        });
      })
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({
            bytesReceived: 6,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
            warning: null,
          }),
        }),
      );

    renderFlow();

    expect(
      await screen.findByText("Resume upload for clip.wav from 3 B committed."),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/workspace?notice=Upload+received.+Verification+has+started.",
      );
    });
    expect(window.localStorage.getItem("superscriber.pendingIngest")).toBeNull();
  });

  it("preserves pending metadata on network interruption during chunk upload and shows safe recovery guidance", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 1234,
    });

    vi.mocked(fetch)
      .mockImplementationOnce(() => mockJsonResponse({ ok: true, status: buildStatus() }))
      .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));

    renderFlow();

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    const resumeNotice = await screen.findByText(STABLE_UPLOAD_INTERRUPTION_RECOVERY_NOTICE, {
      selector: "section.ingest-resume-card span",
    });
    expect(resumeNotice).toBeVisible();
    expect(
      screen.getByText(STABLE_UPLOAD_INTERRUPTION_RECOVERY_NOTICE, {
        selector: "p.body-copy",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();

    const pending = window.localStorage.getItem("superscriber.pendingIngest");
    expect(pending).not.toBeNull();
    expect(JSON.parse(String(pending))).toEqual({
      sessionId: "session-1",
      fileName: "clip.wav",
      fileSize: 6,
      fileType: "audio/wav",
      fileLastModified: 1234,
      source: "upload",
    });
  });

  it("starts a fresh session when the selected file does not match pending identity", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 4321,
    });

    window.localStorage.setItem(
      "superscriber.pendingIngest",
      JSON.stringify({
        sessionId: "session-older",
        fileName: "clip.wav",
        fileSize: 6,
        fileType: "audio/wav",
        fileLastModified: 1234,
        source: "upload",
      }),
    );

    vi.mocked(fetch)
      .mockImplementationOnce(() => mockJsonResponse({ ok: true, status: buildStatus({ sessionId: "session-new" }) }))
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ sessionId: "session-new", bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }) }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({
            sessionId: "session-new",
            bytesReceived: 6,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
            warning: null,
          }),
        }),
      );

    renderFlow();

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/ingest/sessions",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) => input === "/api/ingest/sessions/session-older"),
    ).toHaveLength(1);
  });

  it("restarts from a new session when the previous upload has expired", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 1234,
    });

    window.localStorage.setItem(
      "superscriber.pendingIngest",
      JSON.stringify({
        sessionId: "session-1",
        fileName: "clip.wav",
        fileSize: 6,
        fileType: "audio/wav",
        fileLastModified: 1234,
        source: "upload",
      }),
    );

    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ nextAction: "restart", verificationSummary: "Temporary upload expired and was cleaned up. Start a new upload session to continue." }) }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ nextAction: "restart", verificationSummary: "Temporary upload expired and was cleaned up. Start a new upload session to continue." }) }),
      )
      .mockImplementationOnce(() => mockJsonResponse({ ok: true, status: buildStatus({ sessionId: "session-2" }) }))
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ sessionId: "session-2", bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }) }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({
            sessionId: "session-2",
            bytesReceived: 6,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
            warning: null,
          }),
        }),
      );

    renderFlow();

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/ingest/sessions",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("reconciles a lost finalize response from authoritative status without re-finalizing", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 1234,
    });

    vi.mocked(fetch)
      .mockImplementationOnce(() => mockJsonResponse({ ok: true, status: buildStatus() }))
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }) }),
      )
      .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          status: buildStatus({
            bytesReceived: 6,
            progressPercent: 100,
            nextAction: "none",
            state: "verified",
            integrityState: "verified",
            tempFilePresent: false,
          }),
        }),
      );

    renderFlow("admin");

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/recordings/recording-1?notice=Upload+received.+Verification+has+started.",
      );
    });
    expect(window.localStorage.getItem("superscriber.pendingIngest")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).includes("/finalize")),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).includes("/chunk")),
    ).toHaveLength(1);
  });

  it("keeps safe pending metadata when finalize reconciliation is unreachable and inspects first after reload", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 1234,
    });

    vi.mocked(fetch)
      .mockImplementationOnce(() => mockJsonResponse({ ok: true, status: buildStatus() }))
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }) }),
      )
      .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")))
      .mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));

    const firstRender = renderFlow();

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    expect(
      await screen.findByText(
        "Superscriber is checking the stored upload. Choose the same file again or reload this page so it can confirm whether verification already started.",
      ),
    ).toBeVisible();
    expect(window.localStorage.getItem("superscriber.pendingIngest")).not.toBeNull();
    expect(mockPush).not.toHaveBeenCalled();

    firstRender.unmount();
    mockPush.mockReset();
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockImplementationOnce(() =>
      mockJsonResponse({
        ok: true,
        status: buildStatus({
          bytesReceived: 6,
          progressPercent: 100,
          nextAction: "none",
          state: "verified",
          integrityState: "verified",
          tempFilePresent: false,
        }),
      }),
    );

    renderFlow();

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/workspace?notice=Upload+received.+Verification+has+started.",
      );
    });
    expect(window.localStorage.getItem("superscriber.pendingIngest")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).includes("/finalize")),
    ).toHaveLength(0);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).includes("/chunk")),
    ).toHaveLength(0);
  });

  it("routes durable dispatch failures without asking for a re-upload", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", {
      type: "audio/wav",
      lastModified: 1234,
    });

    vi.mocked(fetch)
      .mockImplementationOnce(() => mockJsonResponse({ ok: true, status: buildStatus() }))
      .mockImplementationOnce(() =>
        mockJsonResponse({ ok: true, status: buildStatus({ bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }) }),
      )
      .mockImplementationOnce(() =>
        mockJsonResponse({
          ok: true,
          nextPath: "/recordings/recording-1",
          status: buildStatus({
            bytesReceived: 6,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
            warning: "Upload stored, but backend dispatch failed: Engine unavailable.",
          }),
        }),
      );

    renderFlow("admin");

    await user.type(screen.getByLabelText("Title"), "Interview 001");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/recordings/recording-1?error=Upload+stored%2C+but+backend+dispatch+failed%3A+Engine+unavailable.",
      );
    });
    expect(window.localStorage.getItem("superscriber.pendingIngest")).toBeNull();
  });

  it("accepts a multi-file selection and announces the count", async () => {
    const user = userEvent.setup();
    renderFlow();

    const input = screen.getByLabelText("Audio or video file") as HTMLInputElement;
    expect(input).toHaveAttribute("multiple");

    await user.upload(input, [
      new File([new ArrayBuffer(6)], "alpha.wav", { type: "audio/wav" }),
      new File([new ArrayBuffer(6)], "delta.wav", { type: "audio/wav" }),
    ]);

    expect(screen.getByTestId("batch-count")).toHaveTextContent("2 files selected.");
  });

  it("uploads every file a forced multi-file selection hands it - the silent-drop counterfactual", async () => {
    const user = userEvent.setup();
    mockBatchServer();

    renderFlow();
    await user.type(screen.getByLabelText("Title"), "Batch harness");
    await user.selectOptions(screen.getByLabelText("Language"), "english");

    // Counterfactual from data/superscriber-multi-upload-regression/report.md
    // section 5.1: a two-file selection forced onto the input must yield two
    // sessions, not a silently dropped second file.
    const input = screen.getByLabelText("Audio or video file", {
      selector: "input",
    }) as HTMLInputElement;
    attachFiles(input, [
      new File([new ArrayBuffer(6)], "alpha.wav", { type: "audio/wav" }),
      new File([new ArrayBuffer(6)], "delta.wav", { type: "audio/wav" }),
    ]);

    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.filter(([target]) => target === "/api/ingest/sessions"),
      ).toHaveLength(2);
    });

    const batch = await screen.findByTestId("batch-results");
    expect(within(batch).getByText("alpha.wav").closest("[data-state]")).toHaveAttribute(
      "data-state",
      "queued",
    );
    expect(within(batch).getByText("delta.wav").closest("[data-state]")).toHaveAttribute(
      "data-state",
      "queued",
    );
    expect(
      screen.getByText("Batch complete: 2 recordings queued for transcription."),
    ).toBeVisible();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("bulk upload runs each file under its own title and surviving failures don't stop the batch", async () => {
    const user = userEvent.setup();
    mockBatchServer({ failOn: "bad.wav" });

    renderFlow();
    await user.type(screen.getByLabelText("Title"), "Batch row evidence");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    const input = screen.getByLabelText("Audio or video file", {
      selector: "input",
    }) as HTMLInputElement;
    await user.upload(input, [
      new File([new ArrayBuffer(6)], "alpha.wav", { type: "audio/wav" }),
      new File([new ArrayBuffer(6)], "bad.wav", { type: "audio/wav" }),
      new File([new ArrayBuffer(6)], "delta.wav", { type: "audio/wav" }),
    ]);
    expect(screen.getByTestId("batch-count")).toHaveTextContent("3 files selected.");

    await user.click(screen.getByRole("button", { name: "Upload file" }));

    const batch = await screen.findByTestId("batch-results");
    await waitFor(() => expect(batch).toHaveTextContent("delta.wav"));

    expect(within(batch).getByText("alpha.wav").closest("[data-state]")).toHaveAttribute(
      "data-state",
      "queued",
    );
    expect(within(batch).getByText("bad.wav").closest("[data-state]")).toHaveAttribute(
      "data-state",
      "failed",
    );
    expect(within(batch).getByText("bad.wav").closest("[data-state]")).toHaveTextContent(
      "Unsupported media type.",
    );
    expect(
      within(batch).getByText("alpha.wav").closest("[data-state]"),
    ).toHaveTextContent("Queued for transcription");

    expect(
      screen.getByText("Batch finished with 1 failed of 3; the rest are queued for transcription."),
    ).toBeVisible();

    const createCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([target]) => target === "/api/ingest/sessions");
    expect(
      createCalls.map(([, init]) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { title: string };
        return body.title;
      }),
    ).toEqual(["alpha", "bad", "delta"]);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("keeps the transfer surface visible between transfers with an honest idle state", () => {
    renderFlow();

    const transfer = screen.getByTestId("transfer-progress");
    expect(transfer).toBeVisible();
    expect(transfer).toHaveTextContent("Idle");
    expect(transfer).toHaveTextContent("No transfer in progress.");
    expect(screen.getByRole("progressbar")).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload file" })).toBeEnabled();
  });

  it("keeps the submit control rendered and disabled during a transfer", async () => {
    const user = userEvent.setup();
    const file = new File(["abcdef"], "clip.wav", { type: "audio/wav" });

    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });

    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/ingest/sessions") {
        return mockJsonResponse({ ok: true, status: buildStatus() });
      }
      if (url.includes("/chunk")) {
        return chunkGate.then(() =>
          mockJsonResponse({
            ok: true,
            status: buildStatus({ bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }),
          }),
        );
      }
      if (url.includes("/finalize")) {
        return mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({
            bytesReceived: 6,
            progressPercent: 100,
            nextAction: "none",
            integrityState: "verified",
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    renderFlow();
    await user.type(screen.getByLabelText("Title"), "In-flight control");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    const busyButton = await screen.findByRole("button", { name: "Uploading..." });
    expect(busyButton).toBeDisabled();
    expect(screen.getByTestId("transfer-progress")).toHaveTextContent("Uploading");
    expect(screen.getByRole("progressbar")).toBeVisible();

    releaseChunk();
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith(
        "/workspace?notice=Upload+received.+Verification+has+started.",
      );
    });
  });

  it("locks the picker and source switcher during a batch and frees them - and capture - afterwards", async () => {
    const user = userEvent.setup();

    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });

    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/ingest/sessions") {
        return mockJsonResponse({ ok: true, status: buildStatus() });
      }
      if (url.includes("/chunk")) {
        return chunkGate.then(() =>
          mockJsonResponse({
            ok: true,
            status: buildStatus({ bytesReceived: 6, progressPercent: 100, nextAction: "finalize" }),
          }),
        );
      }
      if (url.includes("/finalize")) {
        return mockJsonResponse({
          ok: true,
          nextPath: "/workspace",
          status: buildStatus({ nextAction: "none", progressPercent: 100 }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    renderFlow();
    await user.type(screen.getByLabelText("Title"), "Batch gating");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    const input = screen.getByLabelText("Audio or video file", {
      selector: "input",
    }) as HTMLInputElement;
    await user.upload(input, [
      new File([new ArrayBuffer(6)], "alpha.wav", { type: "audio/wav" }),
      new File([new ArrayBuffer(6)], "delta.wav", { type: "audio/wav" }),
    ]);

    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(input).toBeDisabled();
    });
    expect(screen.getByRole("radio", { name: /Upload file/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Record audio/ })).toBeDisabled();

    releaseChunk();
    await waitFor(() => {
      expect(
        screen.getByText("Batch complete: 2 recordings queued for transcription."),
      ).toBeVisible();
    });

    expect(input).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Upload file/ })).toBeEnabled();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("clears a stale resume notice once the batch supersedes the pending ingest", async () => {
    const user = userEvent.setup();
    mockBatchServer();

    window.localStorage.setItem(
      "superscriber.pendingIngest",
      JSON.stringify({
        sessionId: "session-stale",
        fileName: "stale.wav",
        fileSize: 6,
        fileType: "audio/wav",
        fileLastModified: 1234,
        source: "upload",
      }),
    );
    vi.mocked(fetch).mockImplementationOnce(() =>
      mockJsonResponse({
        ok: true,
        status: buildStatus({ sessionId: "session-stale", bytesReceived: 3, progressPercent: 50 }),
      }),
    );

    renderFlow();

    expect(
      await screen.findByText("Resume upload for stale.wav from 3 B committed."),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Title"), "Batch supersedes");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    const input = screen.getByLabelText("Audio or video file", {
      selector: "input",
    }) as HTMLInputElement;
    await user.upload(input, [
      new File([new ArrayBuffer(6)], "alpha.wav", { type: "audio/wav" }),
      new File([new ArrayBuffer(6)], "delta.wav", { type: "audio/wav" }),
    ]);

    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(
        screen.getByText("Batch complete: 2 recordings queued for transcription."),
      ).toBeVisible();
    });
    expect(
      screen.queryByText("Resume upload for stale.wav from 3 B committed."),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem("superscriber.pendingIngest")).toBeNull();
  });
});

const MODEL_CATALOG = {
  configuredModel: "small",
  defaultModel: "large-v3-turbo",
  tiers: [
    {
      id: "large-v3",
      speedNote: "Slowest on CPU (largest model)",
      qualityNote: "Best accuracy; high-stakes recordings",
      available: false,
      default: false,
      downloadSizeBytes: 3_090_835_362,
    },
    {
      id: "large-v3-turbo",
      speedNote: "Much faster than large-v3",
      qualityNote: "Near-large accuracy",
      available: true,
      default: true,
      downloadSizeBytes: 1_621_665_643,
    },
    {
      id: "tiny",
      speedNote: "Fastest",
      qualityNote: "Smoke tests only",
      available: true,
      default: false,
      downloadSizeBytes: 78_203_619,
    },
  ],
};

function mockCatalogServer(catalog: typeof MODEL_CATALOG | {
  configuredModel: string;
  defaultModel: null;
  tiers: typeof MODEL_CATALOG.tiers;
} = MODEL_CATALOG) {
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    if (url === "/api/models/catalog") {
      return mockJsonResponse(catalog);
    }
    if (url === "/api/ingest/sessions" && init?.method === "POST") {
      return mockJsonResponse({ ok: true, status: buildStatus() });
    }
    if (url.includes("/chunk")) {
      const start = Number((init?.headers as Record<string, string>)["x-superscriber-byte-start"]);
      const size = (init?.body as ArrayBuffer).byteLength;
      return mockJsonResponse({
        ok: true,
        status: buildStatus({
          bytesReceived: start + size,
          bytesExpected: start + size,
          progressPercent: 100,
          nextAction: "finalize",
        }),
      });
    }
    if (url.includes("/finalize")) {
      return mockJsonResponse({
        ok: true,
        nextPath: "/workspace",
        status: buildStatus({ progressPercent: 100, nextAction: "none" }),
      });
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

describe("model tier picker (demo-model-tier-picker)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
    global.fetch = vi.fn();
  });

  it("loads the catalog lazily on first Advanced settings expansion, selects the host default, and disables unprovisioned tiers", async () => {
    const user = userEvent.setup();
    mockCatalogServer();
    renderFlow();

    // No catalog request before the disclosure opens; control stays inert.
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/models/catalog")).toBe(false);
    expect(screen.getByLabelText("Transcription model")).toBeDisabled();

    await user.click(screen.getByText("Advanced settings"));

    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => {
      expect(select).toBeEnabled();
    });
    expect(fetch).toHaveBeenCalledWith("/api/models/catalog", { cache: "no-store" });

    const unprovisioned = screen.getByRole("option", {
      name: "large-v3 - not available on this host",
    }) as HTMLOptionElement;
    expect(unprovisioned.disabled).toBe(true);
    expect(
      screen.getByRole("option", { name: "large-v3-turbo - default" }),
    ).toBeEnabled();
    expect(screen.getByRole("option", { name: "tiny" })).toBeEnabled();
    // The server-named default is preselected.
    expect((select as HTMLSelectElement).value).toBe("large-v3-turbo");

    // Unprovisioned tiers are announced in the notes list too.
    expect(screen.getByRole("list", { name: "Model speed and quality notes" })).toHaveTextContent(
      "large-v3: Best accuracy; high-stakes recordings · Slowest on CPU (largest model) - not provisioned here",
    );
    expect(screen.getByText("Configured worker model: small.")).toBeVisible();
    expect(screen.getByText(/If it cannot run, the worker falls back/)).toHaveTextContent(
      "revision summary",
    );
  });

  it("keeps the selection empty when no tier is provisioned", async () => {
    const user = userEvent.setup();
    mockCatalogServer({
      configuredModel: "large-v3",
      defaultModel: null,
      tiers: MODEL_CATALOG.tiers.map((tier) => ({
        ...tier,
        available: false,
        default: false,
      })),
    });
    renderFlow();

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: "No provisioned models available" })).toBeEnabled();

    await user.type(screen.getByLabelText("Title"), "Unprovisioned host interview");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(
      screen.getByLabelText("Audio or video file"),
      new File(["abcdef"], "clip.wav", { type: "audio/wav" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    const sessionCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input) === "/api/ingest/sessions" && init?.method === "POST",
      );
    const body = JSON.parse(String(sessionCall?.[1]?.body)) as Record<string, unknown>;
    expect(body.transcriptModel).toBeNull();
  });

  it("sends the chosen tier on the ingest session and leaves untouched picks at the engine default", async () => {
    const user = userEvent.setup();
    mockCatalogServer();
    renderFlow();

    await user.type(screen.getByLabelText("Title"), "Tiered interview");
    await user.selectOptions(screen.getByLabelText("Language"), "english");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => {
      expect(select).toBeEnabled();
    });
    await user.selectOptions(select, "tiny");

    await user.upload(screen.getByLabelText("Audio or video file"), new File(["abcdef"], "clip.wav", { type: "audio/wav" }));
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalled();
    });

    const sessionCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input) === "/api/ingest/sessions" && init?.method === "POST",
      );
    expect(sessionCall).toBeTruthy();
    const body = JSON.parse(String(sessionCall?.[1]?.body)) as Record<string, unknown>;
    expect(body.transcriptModel).toBe("tiny");
  });

  it("omits transcriptModel when Advanced settings was never opened", async () => {
    const user = userEvent.setup();
    mockCatalogServer();
    renderFlow();

    await user.type(screen.getByLabelText("Title"), "Plain interview");
    await user.selectOptions(screen.getByLabelText("Language"), "english");
    await user.upload(screen.getByLabelText("Audio or video file"), new File(["abcdef"], "clip.wav", { type: "audio/wav" }));
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalled();
    });

    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/models/catalog")).toBe(false);
    const sessionCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input) === "/api/ingest/sessions" && init?.method === "POST",
      );
    const body = JSON.parse(String(sessionCall?.[1]?.body)) as Record<string, unknown>;
    expect(body.transcriptModel).toBeNull();
  });
});

// model-tier-provisioning: admins can install an unprovisioned tier straight
// from the picker - size on the button, live progress, honest failures - and
// the tier flips selectable when the install lands. Uploaders and
// phone-safety sessions never see the controls.
type ProvisioningFixture = Record<
  string,
  { state: "idle" | "downloading" | "completed" | "failed"; bytesReceived: number; bytesTotal: number; error: string | null }
>;

function provisioningBody(fixture: ProvisioningFixture) {
  return {
    activeTierId:
      Object.entries(fixture).find(([, view]) => view.state === "downloading")?.[0] ?? null,
    tiers: Object.entries(fixture).map(([tierId, view]) => ({
      tierId,
      available: view.state === "completed",
      downloadSizeBytes: 78_203_619,
      download: view,
    })),
  };
}

function mockProvisioningServer(options: {
  catalog: typeof MODEL_CATALOG;
  statuses: ProvisioningFixture[];
  postResponse?: { status: number; body: unknown };
  downloadTierId?: string;
  catalogAfterDownload?: typeof MODEL_CATALOG;
  delayedInitialStatus?: Promise<Response>;
  statusDelayMs?: number;
}) {
  let statusCalls = 0;
  let catalogCalls = 0;
  const downloadTierId = options.downloadTierId ?? "tiny";
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    if (url === "/api/models/catalog") {
      const catalog = options.catalog;
      catalogCalls += 1;
      if (catalogCalls > 1) {
        if (options.catalogAfterDownload) {
          return mockJsonResponse(options.catalogAfterDownload);
        }
        return mockJsonResponse({
          ...catalog,
          tiers: catalog.tiers.map((tier) =>
            tier.id === "tiny"
              ? { ...tier, available: true }
              : tier,
          ),
        });
      }
      return mockJsonResponse(catalog);
    }
    if (url === "/api/models/provisioning" && init?.method === "POST") {
      const reply = options.postResponse ?? {
        status: 202,
        body: {
          ok: true,
          status: {
            tierId: downloadTierId,
            state: "downloading",
            bytesReceived: 0,
            bytesTotal: 78_203_619,
            error: null,
            startedAt: "2026-08-11T00:00:00.000Z",
            finishedAt: null,
          },
        },
      };
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url === "/api/models/provisioning") {
      if (statusCalls === 0 && options.delayedInitialStatus) {
        statusCalls += 1;
        return options.delayedInitialStatus;
      }
      const statusIndex = statusCalls - (options.delayedInitialStatus ? 1 : 0);
      const fixture = options.statuses[Math.min(statusIndex, options.statuses.length - 1)];
      statusCalls += 1;
      const response = mockJsonResponse(provisioningBody(fixture));
      if (!options.statusDelayMs) {
        return response;
      }
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          void response.then(resolve);
        }, options.statusDelayMs);
      });
    }
    if (url === "/api/ingest/sessions" && init?.method === "POST") {
      return mockJsonResponse({ ok: true, status: buildStatus() });
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
  return {
    get statusCalls() {
      return statusCalls;
    },
    get catalogCalls() {
      return catalogCalls;
    },
  };
}

const UNPROVISIONED_TINY_CATALOG = {
  configuredModel: "small",
  defaultModel: "large-v3-turbo",
  tiers: MODEL_CATALOG.tiers.map((tier) =>
    tier.id === "tiny" ? { ...tier, available: false } : tier,
  ),
};

describe("model tier provisioning (model-tier-provisioning)", () => {
  beforeEach(() => {
    mockPhoneSafety.value = false;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
    global.fetch = vi.fn();
  });

  it("shows admins a sized Download action per unprovisioned tier, completes it, and flips the tier selectable", async () => {
    const user = userEvent.setup();
    mockProvisioningServer({
      catalog: UNPROVISIONED_TINY_CATALOG,
      statuses: [
        // First status read (after catalog load): tiny idle.
        { tiny: { state: "idle", bytesReceived: 0, bytesTotal: 78_203_619, error: null } },
        // After POST: in flight, part way.
        { tiny: { state: "downloading", bytesReceived: 39_101_810, bytesTotal: 78_203_619, error: null } },
        // Poll: complete.
        { tiny: { state: "completed", bytesReceived: 78_203_619, bytesTotal: 78_203_619, error: null } },
      ],
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toBeEnabled());

    const download = await screen.findByRole("button", { name: "Download tiny (74.6 MB)" });
    // Available tiers never offer a download control.
    expect(screen.queryByRole("button", { name: /Download large-v3-turbo/ })).not.toBeInTheDocument();
    await user.click(download);

    // One-click start hit the server route.
    await waitFor(() => {
      expect(
        vi.mocked(fetch).mock.calls.some(
          ([url, init]) => String(url) === "/api/models/provisioning" && init?.method === "POST",
        ),
      ).toBe(true);
    });

    // Progress view while it runs.
    expect(
      await screen.findByRole("progressbar", { name: "Downloading tiny model" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Downloading tiny:/)).toHaveTextContent(
      "Downloading tiny: 37.3 MB of 74.6 MB",
    );

    // Completion flips the tier selectable in the refreshed catalog - no reload.
    await waitFor(
      () => {
        expect(screen.getByRole("option", { name: "tiny" })).toBeEnabled();
      },
      { timeout: 5_000 },
    );
    expect(screen.queryByRole("button", { name: /Download tiny/ })).not.toBeInTheDocument();
  });

  it("ignores a delayed older status response and continues polling to completion", async () => {
    const user = userEvent.setup();
    let resolveInitialStatus: ((response: Response) => void) | undefined;
    const initialStatus = new Promise<Response>((resolve) => {
      resolveInitialStatus = resolve;
    });
    const server = mockProvisioningServer({
      catalog: UNPROVISIONED_TINY_CATALOG,
      delayedInitialStatus: initialStatus,
      statuses: [
        {
          tiny: {
            state: "downloading",
            bytesReceived: 39_101_810,
            bytesTotal: 78_203_619,
            error: null,
          },
        },
        {
          tiny: {
            state: "completed",
            bytesReceived: 78_203_619,
            bytesTotal: 78_203_619,
            error: null,
          },
        },
      ],
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(await screen.findByRole("button", { name: "Download tiny (74.6 MB)" }));
    await waitFor(() => expect(server.statusCalls).toBe(2));

    resolveInitialStatus?.(
      await mockJsonResponse(
        provisioningBody({
          tiny: {
            state: "idle",
            bytesReceived: 0,
            bytesTotal: 78_203_619,
            error: null,
          },
        }),
      ),
    );

    await waitFor(() => expect(screen.getByRole("option", { name: "tiny" })).toBeEnabled(), {
      timeout: 3_000,
    });
  });

  it("keeps polling when each status response exceeds the poll cadence", async () => {
    const user = userEvent.setup();
    mockProvisioningServer({
      catalog: UNPROVISIONED_TINY_CATALOG,
      statusDelayMs: 900,
      statuses: [
        { tiny: { state: "idle", bytesReceived: 0, bytesTotal: 78_203_619, error: null } },
        {
          tiny: {
            state: "downloading",
            bytesReceived: 39_101_810,
            bytesTotal: 78_203_619,
            error: null,
          },
        },
        {
          tiny: {
            state: "completed",
            bytesReceived: 78_203_619,
            bytesTotal: 78_203_619,
            error: null,
          },
        },
      ],
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(await screen.findByRole("button", { name: "Download tiny (74.6 MB)" }));

    await waitFor(() => expect(screen.getByRole("option", { name: "tiny" })).toBeEnabled(), {
      timeout: 3_000,
    });
  });

  it("adopts the refreshed best available tier when the user has not touched the picker", async () => {
    const user = userEvent.setup();
    const catalog = {
      ...MODEL_CATALOG,
      defaultModel: "tiny",
      tiers: MODEL_CATALOG.tiers.map((tier) => ({
        ...tier,
        available: tier.id === "tiny",
        default: tier.id === "tiny",
      })),
    };
    const catalogAfterDownload = {
      ...catalog,
      defaultModel: "large-v3-turbo",
      tiers: catalog.tiers.map((tier) => ({
        ...tier,
        available: tier.id === "tiny" || tier.id === "large-v3-turbo",
        default: tier.id === "large-v3-turbo",
      })),
    };
    mockProvisioningServer({
      catalog,
      catalogAfterDownload,
      downloadTierId: "large-v3-turbo",
      statuses: [
        { "large-v3-turbo": { state: "idle", bytesReceived: 0, bytesTotal: 1_621_665_643, error: null } },
        { "large-v3-turbo": { state: "downloading", bytesReceived: 1, bytesTotal: 1_621_665_643, error: null } },
        { "large-v3-turbo": { state: "completed", bytesReceived: 1_621_665_643, bytesTotal: 1_621_665_643, error: null } },
      ],
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toHaveValue("tiny"));
    await user.click(
      await screen.findByRole("button", { name: "Download large-v3-turbo (1.5 GB)" }),
    );

    await waitFor(() => expect(select).toHaveValue("large-v3-turbo"), { timeout: 5_000 });
  });

  it("preserves a user-chosen tier when a stronger download completes", async () => {
    const user = userEvent.setup();
    const catalog = {
      ...MODEL_CATALOG,
      defaultModel: "large-v3-turbo",
      tiers: MODEL_CATALOG.tiers.map((tier) => ({
        ...tier,
        available: tier.id !== "large-v3",
        default: tier.id === "large-v3-turbo",
      })),
    };
    const catalogAfterDownload = {
      ...catalog,
      defaultModel: "large-v3",
      tiers: catalog.tiers.map((tier) => ({
        ...tier,
        available: true,
        default: tier.id === "large-v3",
      })),
    };
    mockProvisioningServer({
      catalog,
      catalogAfterDownload,
      downloadTierId: "large-v3",
      statuses: [
        { "large-v3": { state: "idle", bytesReceived: 0, bytesTotal: 3_090_835_362, error: null } },
        { "large-v3": { state: "downloading", bytesReceived: 1, bytesTotal: 3_090_835_362, error: null } },
        { "large-v3": { state: "completed", bytesReceived: 3_090_835_362, bytesTotal: 3_090_835_362, error: null } },
      ],
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toHaveValue("large-v3-turbo"));
    await user.selectOptions(select, "tiny");
    await user.click(await screen.findByRole("button", { name: "Download large-v3 (2.9 GB)" }));

    await waitFor(() => expect(screen.getByRole("option", { name: "large-v3 - default" })).toBeEnabled(), {
      timeout: 5_000,
    });
    expect(select).toHaveValue("tiny");
  });

  it("surfaces a refused start honestly (for example a full disk) and leaves the action retryable", async () => {
    const user = userEvent.setup();
    mockProvisioningServer({
      catalog: UNPROVISIONED_TINY_CATALOG,
      statuses: [
        { tiny: { state: "idle", bytesReceived: 0, bytesTotal: 78_203_619, error: null } },
        {
          tiny: {
            state: "failed",
            bytesReceived: 12,
            bytesTotal: 78_203_619,
            error: "network reset mid-file",
          },
        },
      ],
      postResponse: {
        status: 507,
        body: {
          error: "insufficient_disk_space",
          message: "Not enough free disk space to install the 'tiny' model.",
        },
      },
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Transcription model" })).toBeEnabled(),
    );

    // A refused start (for example a full disk) surfaces inline.
    await user.click(await screen.findByRole("button", { name: "Download tiny (74.6 MB)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Not enough free disk space to install the 'tiny' model.",
    );
    // The action stays available for a retry.
    expect(screen.getByRole("button", { name: "Download tiny (74.6 MB)" })).toBeEnabled();
  });

  it("keeps a mid-download failure on screen with the server error and a retry", async () => {
    const user = userEvent.setup();
    mockProvisioningServer({
      catalog: UNPROVISIONED_TINY_CATALOG,
      statuses: [
        { tiny: { state: "idle", bytesReceived: 0, bytesTotal: 78_203_619, error: null } },
        { tiny: { state: "downloading", bytesReceived: 100, bytesTotal: 78_203_619, error: null } },
        {
          tiny: {
            state: "failed",
            bytesReceived: 100,
            bytesTotal: 78_203_619,
            error: "network reset mid-file",
          },
        },
      ],
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toBeEnabled());

    await user.click(await screen.findByRole("button", { name: "Download tiny (74.6 MB)" }));

    expect(
      await screen.findByRole(
        "alert",
        {},
        { timeout: 5_000 },
      ),
    ).toHaveTextContent("Download of tiny failed: network reset mid-file");
    expect(screen.getByRole("button", { name: /Retry download tiny/ })).toBeEnabled();
    // The tier never turned selectable off a failed install.
    expect(screen.getByRole("option", { name: "tiny - not available on this host" })).toBeDisabled();
  });

  it("hides the controls from uploaders entirely", async () => {
    const user = userEvent.setup();
    const server = mockProvisioningServer({
      catalog: UNPROVISIONED_TINY_CATALOG,
      statuses: [
        { tiny: { state: "downloading", bytesReceived: 1, bytesTotal: 78_203_619, error: null } },
      ],
    });
    renderFlow("uploader");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toBeEnabled());

    expect(screen.queryByRole("button", { name: /Download / })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: /Downloading/ })).not.toBeInTheDocument();
    // An uploader never even polls the provisioning surface.
    expect(server.statusCalls).toBe(0);
  });

  it("hides the controls in phone-safety mode even for admins", async () => {
    mockPhoneSafety.value = true;
    const user = userEvent.setup();
    const server = mockProvisioningServer({
      catalog: UNPROVISIONED_TINY_CATALOG,
      statuses: [
        { tiny: { state: "idle", bytesReceived: 0, bytesTotal: 78_203_619, error: null } },
      ],
    });
    renderFlow("admin");

    await user.click(screen.getByText("Advanced settings"));
    const select = await screen.findByRole("combobox", { name: "Transcription model" });
    await waitFor(() => expect(select).toBeEnabled());

    expect(screen.queryByRole("button", { name: /Download / })).not.toBeInTheDocument();
    expect(server.statusCalls).toBe(0);
  });
});
