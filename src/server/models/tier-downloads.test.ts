import { describe, expect, it } from "vitest";

import { MODEL_TIER_IDS } from "./catalog";
import {
  HUGGINGFACE_DOWNLOAD_BASE_URL,
  modelTierDownloadUrls,
  modelTierOptionalDownloadUrls,
  TIER_DOWNLOADS,
} from "./tier-downloads";

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
      // Optional artifacts stay orthogonal to the required set and its size
      // accounting: older provisioned bundles never had them and must keep
      // reporting as available.
      expect(Object.keys(source.optionalFileSizeBytes).sort()).toEqual(
        [...source.optionalFiles].sort(),
      );
      for (const file of source.optionalFiles) {
        expect(source.files).not.toContain(file);
      }
    }
  });

  it("offers preprocessor_config.json as an optional artifact on the 128-mel v3 family", () => {
    // The v3 family needs a 128-mel frontend; when a bundle carries no
    // preprocessor_config.json, faster-whisper silently falls back to 80.
    for (const tierId of ["large-v3", "large-v3-turbo", "distil-large-v3"] as const) {
      expect(TIER_DOWNLOADS[tierId].optionalFiles).toEqual(["preprocessor_config.json"]);
      expect(modelTierOptionalDownloadUrls(tierId)[0]).toBe(
        `${HUGGINGFACE_DOWNLOAD_BASE_URL}/${TIER_DOWNLOADS[tierId].repository}/resolve/${TIER_DOWNLOADS[tierId].revision}/preprocessor_config.json`,
      );
      expect(TIER_DOWNLOADS[tierId].optionalFileSizeBytes["preprocessor_config.json"]).toBe(340);
    }
    for (const tierId of MODEL_TIER_IDS) {
      if (["large-v3", "large-v3-turbo", "distil-large-v3"].includes(tierId)) continue;
      expect(TIER_DOWNLOADS[tierId].optionalFiles).toEqual([]);
      expect(modelTierOptionalDownloadUrls(tierId)).toEqual([]);
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
