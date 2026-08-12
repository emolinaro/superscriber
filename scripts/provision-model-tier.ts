// local-deploy-bootstrap: operator-facing CLI over the SAME model-tier
// install path the app itself exposes (src/server/models/provisioning.ts).
// No ad-hoc downloads: artifacts come from the pinned, commit-SHA-locked
// Hugging Face sources in src/server/models/tier-downloads.ts, stage under
// .provisioning/, and only then rename into place, so a tier is never
// observed half-written. An already-provisioned tier is detected from the
// on-disk artifacts and skipped, which makes re-runs offline-capable.
//
// Usage:
//   npx tsx scripts/provision-model-tier.ts --list
//   SUPERSCRIBER_TRANSCRIBE_MODEL_DIR=<dir> npx tsx scripts/provision-model-tier.ts --tier small

import {
  isModelProvisioned,
  listModelCatalog,
  MODEL_TIER_IDS,
} from "@/server/models/catalog";
import {
  listProvisioningStatus,
  ProvisioningError,
  startTierDownload,
  waitForTierDownload,
} from "@/server/models/provisioning";

const POLL_INTERVAL_MS = 1000;

function usage(): never {
  console.error(
    "Usage: provision-model-tier.ts --list | --tier <tier-id>\n" +
      `Known tiers: ${MODEL_TIER_IDS.join(", ")}`,
  );
  process.exit(64);
}

function parseArgs(argv: string[]): { list: boolean; tierId: string | null } {
  let list = false;
  let tierId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      list = true;
    } else if (arg === "--tier") {
      tierId = argv[index + 1] ?? null;
      index += 1;
    } else {
      usage();
    }
  }
  return { list, tierId };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printCatalog() {
  const catalog = listModelCatalog();
  for (const tier of catalog.tiers) {
    const sizeMiB = Math.round(tier.downloadSizeBytes / (1024 * 1024));
    const state = tier.available ? "provisioned" : "not installed";
    const marker = tier.id === catalog.configuredModel ? " (catalog default)" : "";
    console.log(
      `${tier.id.padEnd(18)} ${String(sizeMiB).padStart(6)} MiB  ${state}${marker}`,
    );
  }
}

function tierView(tierId: string) {
  const view = listProvisioningStatus().tiers.find((tier) => tier.tierId === tierId);
  if (!view) {
    throw new Error(`Provisioning status for tier '${tierId}' disappeared.`);
  }
  return view;
}

async function startDownload(tierId: string) {
  while (true) {
    if (isModelProvisioned(tierId)) {
      return false;
    }
    try {
      startTierDownload(tierId);
      return true;
    } catch (error) {
      if (
        error instanceof ProvisioningError &&
        error.code === "tier_already_provisioned"
      ) {
        return false;
      }
      if (
        error instanceof ProvisioningError &&
        error.code === "download_in_progress"
      ) {
        const activeTierId = listProvisioningStatus().activeTierId;
        console.log(
          `Another model download${activeTierId ? ` ('${activeTierId}')` : ""} is in progress; waiting for it to finish.`,
        );
        if (activeTierId) {
          await waitForTierDownload(activeTierId);
        } else {
          await sleep(POLL_INTERVAL_MS);
        }
        continue;
      }
      throw error;
    }
  }
}

async function provision(tierId: string): Promise<number> {
  if (!MODEL_TIER_IDS.includes(tierId)) {
    console.error(
      `Unknown model tier '${tierId}'. Known tiers: ${MODEL_TIER_IDS.join(", ")}`,
    );
    return 64;
  }

  const started = await startDownload(tierId);
  if (!started) {
    console.log(
      `Model tier '${tierId}' is already provisioned; skipping download.`,
    );
    return 0;
  }

  console.log(`Downloading model tier '${tierId}'...`);
  let lastLoggedPercent = -10;
  while (true) {
    const view = tierView(tierId);

    if (view.download.state === "completed" || view.available) {
      console.log(`Model tier '${tierId}' provisioned successfully.`);
      return 0;
    }
    if (view.download.state === "failed") {
      console.error(
        `Model tier '${tierId}' download failed: ${view.download.error ?? "unknown error"}`,
      );
      return 1;
    }
    if (view.download.state !== "downloading") {
      // Neither downloading, completed, nor failed: nothing is in flight and
      // the artifacts are absent - treat as a failed start rather than hang.
      console.error(
        `Model tier '${tierId}' did not start downloading (state: ${view.download.state}).`,
      );
      return 1;
    }

    const percent =
      view.download.bytesTotal > 0
        ? Math.floor((view.download.bytesReceived / view.download.bytesTotal) * 100)
        : 0;
    if (percent >= lastLoggedPercent + 10) {
      lastLoggedPercent = percent;
      console.log(`  ...${percent}%`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function main() {
  const { list, tierId } = parseArgs(process.argv.slice(2));
  if (list) {
    printCatalog();
    return;
  }
  if (!tierId) {
    usage();
  }
  process.exitCode = await provision(tierId);
}

void main();
