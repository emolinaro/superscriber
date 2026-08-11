import { existsSync } from "node:fs";
import { join } from "node:path";

// demo-model-tier-picker: the faster-whisper tier catalog. Availability is
// SERVER-CHECKED against actual provisioned artifacts (model.bin +
// config.json) in the worker's model directory - a tier is selectable only
// when verifiably usable on this host; everything else renders as explicitly
// unavailable. The default is the highest-quality provisioned tier, honoring
// SUPERSCRIBER_TRANSCRIBE_MODEL when that default itself is provisioned.

export type ModelTier = {
  id: string;
  qualityRank: number;
  speedNote: string;
  qualityNote: string;
  available: boolean;
  default: boolean;
};

const TIER_META: Array<{ id: string; qualityRank: number; speedNote: string; qualityNote: string }> = [
  { id: "large-v3", qualityRank: 9, speedNote: "Slowest on CPU (largest model)", qualityNote: "Best accuracy; high-stakes recordings" },
  { id: "large-v3-turbo", qualityRank: 8, speedNote: "Much faster than large-v3", qualityNote: "Near-large accuracy" },
  { id: "distil-large-v3", qualityRank: 7, speedNote: "Fast for a large model", qualityNote: "Distilled large quality" },
  { id: "large-v2", qualityRank: 6, speedNote: "Slow on CPU", qualityNote: "Earlier large generation" },
  { id: "large-v1", qualityRank: 5, speedNote: "Slow on CPU", qualityNote: "Original large generation" },
  { id: "medium", qualityRank: 4, speedNote: "Moderate", qualityNote: "Balanced mid-tier" },
  { id: "small", qualityRank: 3, speedNote: "Fast", qualityNote: "Good for drafts and short clips" },
  { id: "base", qualityRank: 2, speedNote: "Very fast", qualityNote: "Rougher output" },
  { id: "tiny", qualityRank: 1, speedNote: "Fastest", qualityNote: "Smoke tests only" },
];

export const MODEL_TIER_IDS = TIER_META.map((tier) => tier.id);

function modelRoot() {
  return (
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR?.trim() ||
    join(process.cwd(), "models")
  );
}

export function isModelProvisioned(tierId: string): boolean {
  if (!MODEL_TIER_IDS.includes(tierId)) {
    return false;
  }
  const dir = join(modelRoot(), tierId);
  return existsSync(join(dir, "model.bin")) && existsSync(join(dir, "config.json"));
}

export function listModelCatalog(): {
  tiers: ModelTier[];
  defaultModel: string;
} {
  const tiers = TIER_META.map((tier) => ({
    ...tier,
    available: isModelProvisioned(tier.id),
    default: false,
  }));

  const configuredDefault = (process.env.SUPERSCRIBER_TRANSCRIBE_MODEL || "").trim();
  let defaultModel = "";
  if (configuredDefault && tiers.some((tier) => tier.id === configuredDefault && tier.available)) {
    defaultModel = configuredDefault;
  } else {
    // Best available quality wins the default.
    const best = [...tiers]
      .filter((tier) => tier.available)
      .sort((a, b) => b.qualityRank - a.qualityRank)[0];
    defaultModel = best ? best.id : configuredDefault || "small";
  }

  return {
    tiers: tiers.map((tier) => ({
      ...tier,
      // A tier whose artifacts are missing can never be the rendered default,
      // even when the configured name exists - the UI stays honest.
      default: tier.available && tier.id === defaultModel,
    })),
    defaultModel,
  };
}
