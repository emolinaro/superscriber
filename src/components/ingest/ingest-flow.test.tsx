// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => false,
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

type MediaRecorderListener = (event?: Event & { data?: Blob }) => void;

function installRecorderSupport() {
  const listeners = new Map<string, Set<MediaRecorderListener>>();

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
        listener({ data: new Blob(["recorded-audio"], { type: "audio/webm" }) } as Event & {
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
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
  });
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

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("IngestFlow", () => {
  beforeEach(() => {
    installRecorderSupport();
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

  it("keeps Upload selectable after microphone denial", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error("Permission denied")),
      },
    });

    renderFlow();

    await user.click(screen.getByRole("radio", { name: /Record audio/ }));    await user.click(screen.getByRole("button", { name: "Start recording" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(
      "Microphone access was blocked. Choose Upload file to continue safely.",
    );

    await user.click(screen.getByRole("radio", { name: /Upload file/ }));    expect(screen.getByLabelText("Audio or video file")).toBeVisible();
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
});
