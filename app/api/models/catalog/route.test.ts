import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  getActivePrincipal: vi.fn(),
}));

import { getActivePrincipal } from "@/server/session";
import { TIER_DOWNLOADS } from "@/server/models/tier-downloads";

const UPLOADER = {
  userId: "user-uploader",
  email: "uploader@example.com",
  displayName: "Uploader",
  role: "uploader" as const,
};

async function callGet() {
  const { GET } = await import("./route");
  return GET();
}

// demo-model-tier-picker: the route must never leak catalog truth to
// anonymous callers, and must mirror the server-checked availability the
// picker depends on.
describe("model catalog route (demo-model-tier-picker)", () => {
  let modelRoot: string;

  beforeEach(() => {
    modelRoot = mkdtempSync(join(tmpdir(), "superscriber-catalog-route-"));
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = modelRoot;
    delete process.env.SUPERSCRIBER_TRANSCRIBE_MODEL;
  });

  afterEach(() => {
    delete process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR;
    delete process.env.SUPERSCRIBER_TRANSCRIBE_MODEL;
    rmSync(modelRoot, { recursive: true, force: true });
    vi.resetAllMocks();
    vi.resetModules();
  });

  function provision(tierId: string) {
    const dir = join(modelRoot, tierId);
    mkdirSync(dir, { recursive: true });
    for (const file of TIER_DOWNLOADS[tierId].files) {
      writeFileSync(
        join(dir, file),
        file === "config.json" ? "{}" : "artifact",
      );
    }
  }

  it("rejects anonymous callers", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(null);

    const response = await callGet();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_expired" });
  });

  it("reports the server-checked availability of every tier, uncached", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(UPLOADER);
    provision("tiny");

    const response = await callGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      tiers: Array<{ id: string; available: boolean; default: boolean }>;
      configuredModel: string;
      defaultModel: string | null;
    };
    expect(body.tiers).toHaveLength(9);
    const byId = Object.fromEntries(body.tiers.map((tier) => [tier.id, tier]));
    expect(byId.tiny.available).toBe(true);
    expect(byId.tiny.default).toBe(true);
    expect(byId["large-v3"].available).toBe(false);
    expect(body.configuredModel).toBe("small");
    expect(body.defaultModel).toBe("tiny");
  });

  it("keeps an unavailable configured model separate from the nullable picker default", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(UPLOADER);
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL = "large-v3";

    const response = await callGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configuredModel: "large-v3",
      defaultModel: null,
    });
  });
});
