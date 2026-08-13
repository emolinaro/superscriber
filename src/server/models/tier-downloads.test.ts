import { describe, expect, it } from "vitest";

import { MODEL_TIER_IDS } from "./catalog";
import { modelTierDownloadUrls, TIER_DOWNLOADS } from "./tier-downloads";

// model-tier-provisioning: download sources are PINNED to huggingface.co
// repository + commit SHA pairs (the same repos faster-whisper's own _MODELS
// map names), so a tier install can never silently fetch moved content.

describe("tier download sources (model-tier-provisioning)", () => {
  it("covers exactly the catalog tiers", () => {
    expect(Object.keys(TIER_DOWNLOADS).sort()).toEqual([...MODEL_TIER_IDS].sort());
  });

  it("pins every tier to a huggingface.co repo at an immutable commit sha", () => {
    for (const source of Object.values(TIER_DOWNLOADS)) {
      expect(source.repository).toMatch(/^[A-Za-z0-9-]+\/faster-(distil-)?whisper-[a-z0-9.-]+$/);
      expect(source.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(source.files).toContain("model.bin");
      expect(source.files).toContain("config.json");
      expect(source.files).toContain("tokenizer.json");
      expect(
        source.files.includes("vocabulary.txt") || source.files.includes("vocabulary.json"),
      ).toBe(true);
      expect(Object.keys(source.fileSizeBytes).sort()).toEqual(
        [...source.files].sort(),
      );
      expect(
        Object.values(source.fileSizeBytes).reduce(
          (total, size) => total + size,
          0,
        ),
      ).toBe(source.sizeBytes);
      expect(source.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("builds pinned resolve URLs on huggingface.co only", () => {
    const urls = modelTierDownloadUrls("tiny");
    expect(urls).toHaveLength(TIER_DOWNLOADS.tiny.files.length);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname).toBe("huggingface.co");
      expect(parsed.pathname).toContain("faster-whisper-tiny");
      expect(parsed.pathname).toContain(TIER_DOWNLOADS.tiny.revision);
    }
    expect(urls).toContain(
      "https://huggingface.co/Systran/faster-whisper-tiny/resolve/d90ca5fe260221311c53c58e660288d3deb8d356/model.bin",
    );
  });

  it("refuses unknown tiers", () => {
    expect(() => modelTierDownloadUrls("not-a-model")).toThrow(/unknown model tier/);
  });
});
