import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  getActivePrincipal: vi.fn(),
}));

vi.mock("@/server/models/provisioning", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/models/provisioning")>();
  return {
    ...original,
    listProvisioningStatus: vi.fn(),
    startTierDownload: vi.fn(),
  };
});

import { getActivePrincipal } from "@/server/session";
import {
  listProvisioningStatus,
  ProvisioningError,
  startTierDownload,
  type ModelTierProvisioningView,
} from "@/server/models/provisioning";

const ADMIN = {
  userId: "user-admin",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin" as const,
};

const UPLOADER = {
  userId: "user-uploader",
  email: "uploader@example.com",
  displayName: "Uploader",
  role: "uploader" as const,
};

function tierView(tierId: string, available = false): ModelTierProvisioningView {
  return {
    tierId,
    available,
    downloadSizeBytes: 1000,
    download: { state: available ? "completed" : "idle", bytesReceived: 0, bytesTotal: 1000, error: null },
  };
}

async function callGet() {
  const { GET } = await import("./route");
  return GET();
}

async function callPost(body: unknown) {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost/api/models/provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// model-tier-provisioning: the provisioning surface is admin-gated for
// writes, readable by any signed-in principal, and translates the service's
// honest failures into matching HTTP answers. The service itself is tested
// against real disks; here it is mocked so every branch is deterministic.
describe("model provisioning route (model-tier-provisioning)", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("rejects anonymous callers on both verbs", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(null);

    const getResponse = await callGet();
    expect(getResponse.status).toBe(401);
    expect(await getResponse.json()).toEqual({ error: "auth_expired" });

    const postResponse = await callPost({ tierId: "tiny" });
    expect(postResponse.status).toBe(401);
  });

  it("serves merged availability and download status to any signed-in role, uncached", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(UPLOADER);
    vi.mocked(listProvisioningStatus).mockReturnValue({
      activeTierId: null,
      tiers: [tierView("tiny", true), tierView("base")],
    });

    const response = await callGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { tiers: unknown[] };
    expect(body.tiers).toHaveLength(2);
  });

  it("forbids provisioning starts for non-admin roles", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(UPLOADER);

    const response = await callPost({ tierId: "tiny" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "access_denied" });
    expect(startTierDownload).not.toHaveBeenCalled();
  });

  it("validates the tier id and request body before touching the service", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(ADMIN);

    const missing = await callPost({});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "validation_error" });
    expect(startTierDownload).not.toHaveBeenCalled();
  });

  it("maps ProvisioningError codes to their HTTP answers", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(ADMIN);

    vi.mocked(startTierDownload).mockImplementation(() => {
      throw new ProvisioningError(400, "unknown_model_tier", "Unknown transcription model tier 'nope'.");
    });
    const unknown = await callPost({ tierId: "nope" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unknown_model_tier" });

    vi.mocked(startTierDownload).mockImplementation(() => {
      throw new ProvisioningError(409, "tier_already_provisioned", "Already provisioned.");
    });
    const conflict = await callPost({ tierId: "tiny" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "tier_already_provisioned" });

    vi.mocked(startTierDownload).mockImplementation(() => {
      throw new ProvisioningError(507, "insufficient_disk_space", "Not enough free space.", {
        requiredBytes: 100,
        freeBytes: 1,
      });
    });
    const full = await callPost({ tierId: "large-v3" });
    expect(full.status).toBe(507);
    expect(await full.json()).toMatchObject({
      error: "insufficient_disk_space",
      requiredBytes: 100,
      freeBytes: 1,
    });
  });

  it("returns 202 with the in-flight status when a download starts", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(ADMIN);
    vi.mocked(startTierDownload).mockReturnValue({
      tierId: "tiny",
      state: "downloading",
      bytesReceived: 0,
      bytesTotal: 78_203_619,
      error: null,
      startedAt: "2026-08-11T00:00:00.000Z",
      finishedAt: null,
    });

    const response = await callPost({ tierId: "tiny" });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { ok: boolean; status: { state: string } };
    expect(body.ok).toBe(true);
    expect(body.status.state).toBe("downloading");
    expect(startTierDownload).toHaveBeenCalledWith("tiny");
  });
});
