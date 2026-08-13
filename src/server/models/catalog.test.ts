import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isModelProvisioned,
  listModelCatalog,
  MODEL_TIER_IDS,
} from "./catalog";
import { TIER_DOWNLOADS } from "./tier-downloads";

// demo-model-tier-picker: availability is server-checked against artifacts;
// nothing may render selectable that the host cannot run.

describe("model catalog (demo-model-tier-picker)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of [
      "SUPERSCRIBER_TRANSCRIBE_MODEL_DIR",
      "SUPERSCRIBER_TRANSCRIBE_MODEL",
      "SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR",
    ]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  function snapshotEnv() {
    savedEnv.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR =
      process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR;
    savedEnv.SUPERSCRIBER_TRANSCRIBE_MODEL =
      process.env.SUPERSCRIBER_TRANSCRIBE_MODEL;
    savedEnv.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR =
      process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR;
    delete process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR;
  }

  function provision(root: string, ...tiers: string[]) {
    for (const tier of tiers) {
      const dir = join(root, tier);
      mkdirSync(dir, { recursive: true });
      for (const file of TIER_DOWNLOADS[tier].files) {
        const artifact = join(dir, file);
        writeFileSync(artifact, "artifact");
        truncateSync(artifact, TIER_DOWNLOADS[tier].fileSizeBytes[file]);
      }
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

  it("keeps a tier unavailable when any pinned artifact is missing", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-partial-"));
    const dir = join(root, "small");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.bin"), "bin");
    writeFileSync(join(dir, "config.json"), "{}");
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;

    expect(isModelProvisioned("small")).toBe(false);
  });

  it("rejects empty and non-file artifacts", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-invalid-"));
    const emptyDir = join(root, "small");
    mkdirSync(emptyDir, { recursive: true });
    for (const file of TIER_DOWNLOADS.small.files) {
      writeFileSync(
        join(emptyDir, file),
        file === "model.bin" ? "" : "artifact",
      );
    }
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;
    expect(isModelProvisioned("small")).toBe(false);

    const directoryTier = join(root, "tiny");
    mkdirSync(directoryTier, { recursive: true });
    for (const file of TIER_DOWNLOADS.tiny.files) {
      if (file === "tokenizer.json") {
        mkdirSync(join(directoryTier, file));
      } else {
        writeFileSync(join(directoryTier, file), "artifact");
      }
    }
    expect(isModelProvisioned("tiny")).toBe(false);
  });

  it("rejects a truncated pinned artifact", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-truncated-"));
    provision(root, "small");
    truncateSync(
      join(root, "small", "model.bin"),
      TIER_DOWNLOADS.small.fileSizeBytes["model.bin"] - 1,
    );
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;

    expect(isModelProvisioned("small")).toBe(false);
  });

  it("rejects a symlinked model tier directory", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "model-catalog-outside-"));
    provision(outside, "small");
    symlinkSync(join(outside, "small"), join(root, "small"));
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;

    expect(isModelProvisioned("small")).toBe(false);
    rmSync(outside, { recursive: true, force: true });
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
    const byId = Object.fromEntries(
      catalog.tiers.map((tier) => [tier.id, tier]),
    );
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

  it("keeps the best-available default even when the configured model is provisioned", () => {
    // model-tier-provisioning (captain ruling): the picker's default is always
    // the best provisioned tier - a provisioned configured model no longer
    // wins the default when a stronger tier is available on the host.
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-default-"));
    provision(root, "small", "large-v3");
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL = "small";

    const catalog = listModelCatalog();
    expect(catalog).toMatchObject({
      configuredModel: "small",
      defaultModel: "large-v3",
    });
    const byId = Object.fromEntries(
      catalog.tiers.map((tier) => [tier.id, tier]),
    );
    expect(byId["large-v3"].default).toBe(true);
    expect(byId["small"].default).toBe(false);
  });

  it("exposes the pinned download size for every tier", () => {
    snapshotEnv();
    const root = mkdtempSync(join(tmpdir(), "model-catalog-sizes-"));
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = root;
    delete process.env.SUPERSCRIBER_TRANSCRIBE_MODEL;

    const catalog = listModelCatalog();
    const byId = Object.fromEntries(
      catalog.tiers.map((tier) => [tier.id, tier]),
    );
    for (const tier of catalog.tiers) {
      expect(Number.isFinite(tier.downloadSizeBytes)).toBe(true);
      expect(tier.downloadSizeBytes).toBeGreaterThan(0);
    }
    expect(byId.tiny.downloadSizeBytes).toBe(78_203_619);
    expect(byId["large-v3-turbo"].downloadSizeBytes).toBe(1_621_665_643);
  });
});
