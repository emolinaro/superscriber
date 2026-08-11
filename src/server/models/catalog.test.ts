import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isModelProvisioned, listModelCatalog, MODEL_TIER_IDS } from "./catalog";

// demo-model-tier-picker: availability is server-checked against artifacts;
// nothing may render selectable that the host cannot run.

describe("model catalog (demo-model-tier-picker)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of [
      "SUPERSCRIBER_TRANSCRIBE_MODEL_DIR",
      "SUPERSCRIBER_TRANSCRIBE_MODEL",
    ]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function snapshotEnv() {
    savedEnv.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR;
    savedEnv.SUPERSCRIBER_TRANSCRIBE_MODEL = process.env.SUPERSCRIBER_TRANSCRIBE_MODEL;
  }

  function provision(root: string, ...tiers: string[]) {
    for (const tier of tiers) {
      const dir = join(root, tier);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "model.bin"), "bin");
      writeFileSync(join(dir, "config.json"), "{}");
    }
  }

  it("marks every tier unavailable with an empty model root", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-empty-"));
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL = "large-v3";

    const catalog = listModelCatalog();
    expect(catalog.tiers.every((tier) => !tier.available)).toBe(true);
    expect(catalog.configuredModel).toBe("large-v3");
    expect(catalog.defaultModel).toBeNull();
    expect(catalog.tiers.every((tier) => !tier.default)).toBe(true);
  });

  it("marks provisioned tiers available and defaults to best provisioned quality", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-full-"));
    provision(root, "tiny", "small", "large-v3-turbo");
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL = "medium";
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;

    const catalog = listModelCatalog();
    expect(catalog.configuredModel).toBe("medium");
    expect(isModelProvisioned("small")).toBe(true);
    expect(isModelProvisioned("large-v3")).toBe(false);
    expect(isModelProvisioned("not-a-model")).toBe(false);
    expect(catalog.defaultModel).toBe("large-v3-turbo");
    const byId = Object.fromEntries(catalog.tiers.map((tier) => [tier.id, tier]));
    expect(byId["large-v3-turbo"].default).toBe(true);
    expect(byId["small"].default).toBe(false);
    expect(byId["large-v3"].available).toBe(false);
    expect(MODEL_TIER_IDS).toEqual([
      "large-v3",
      "large-v3-turbo",
      "distil-large-v3",
      "large-v2",
      "large-v1",
      "medium",
      "small",
      "base",
      "tiny",
    ]);
  });

  it("honors a provisioned configured default over the quality rank", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-default-"));
    provision(root, "small", "large-v3");
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL = "small";

    expect(listModelCatalog()).toMatchObject({
      configuredModel: "small",
      defaultModel: "small",
    });
  });
});
