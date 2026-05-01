import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  getActivePrincipal: vi.fn(),
}));

vi.mock("@/server/repository", () => ({
  resolveApprovedTranscriptExportForPrincipal: vi.fn(),
}));

import { resolveApprovedTranscriptExportForPrincipal } from "@/server/repository";
import { getActivePrincipal } from "@/server/session";
import { GET } from "./route";

describe("GET /api/recordings/[recordingId]/transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActivePrincipal).mockResolvedValue({
      userId: "user-admin",
      email: "admin@example.com",
      displayName: "Admin",
      role: "admin",
    });
  });

  it("defaults format omission to txt", async () => {
    vi.mocked(resolveApprovedTranscriptExportForPrincipal).mockResolvedValue({
      denied: false,
      missing: false,
      fileName: "approved.txt",
      contentType: "text/plain; charset=utf-8",
      body: new TextEncoder().encode("approved transcript"),
    });

    const response = await GET(
      new Request("https://example.test/api/recordings/rec-123/transcript"),
      { params: Promise.resolve({ recordingId: "rec-123" }) },
    );

    expect(response.status).toBe(200);
    expect(resolveApprovedTranscriptExportForPrincipal).toHaveBeenCalledWith(
      "rec-123",
      expect.objectContaining({ role: "admin" }),
      "txt",
    );
  });

  it("returns 400 for unsupported formats", async () => {
    const response = await GET(
      new Request(
        "https://example.test/api/recordings/rec-123/transcript?format=pdf",
      ),
      { params: Promise.resolve({ recordingId: "rec-123" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Unsupported transcript export format.");
    expect(resolveApprovedTranscriptExportForPrincipal).not.toHaveBeenCalled();
  });

  it("uses repository-provided headers and body for successful exports", async () => {
    const body = new Uint8Array([0, 1, 2, 3, 4, 5]).subarray(1, 5);

    vi.mocked(resolveApprovedTranscriptExportForPrincipal).mockResolvedValue({
      denied: false,
      missing: false,
      fileName: "approved.json",
      contentType: "application/json; charset=utf-8",
      body,
    });

    const response = await GET(
      new Request(
        "https://example.test/api/recordings/rec-123/transcript?format=json",
      ),
      { params: Promise.resolve({ recordingId: "rec-123" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="approved.json"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(resolveApprovedTranscriptExportForPrincipal).toHaveBeenCalledWith(
      "rec-123",
      expect.objectContaining({ role: "admin" }),
      "json",
    );
  });
});
