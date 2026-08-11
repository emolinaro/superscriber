import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";

import { isModelProvisioned, MODEL_TIER_IDS } from "./catalog";
import {
  HUGGINGFACE_DOWNLOAD_BASE_URL,
  modelTierDownloadUrls,
  TIER_DOWNLOADS,
} from "./tier-downloads";

// model-tier-provisioning: server-side tier installs for the ingest picker.
// A download stages the pinned faster-whisper artifact set under
// "<modelRoot>/.provisioning/<tier>/" and only then reveals
// "<modelRoot>/<tier>/" (model.bin last, since the catalog gate keys on
// model.bin + config.json), so the catalog can never observe a half-written
// tier. Failures delete both the staging and target directories and stay on
// the record until a retry succeeds - the picker renders them honestly.
//
// Network surface: exactly the pinned huggingface.co resolve URLs from
// tier-downloads.ts. The SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR seam is a
// test-only bypass: when a fixture directory with the tier's COMPLETE file
// set exists, the transport copies from disk instead of fetching, so e2e
// lanes without network can still drive the full flow. Production images
// never set it.

export const DISK_SPACE_HEADROOM = 1.05;

export type TierDownloadState = "idle" | "downloading" | "completed" | "failed";

export type TierDownloadStatus = {
  tierId: string;
  state: TierDownloadState;
  bytesReceived: number;
  bytesTotal: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type DownloadProgress = { bytesReceived: number; bytesTotal: number };

export type DownloadTransport = (
  url: string,
  destination: string,
  onProgress: (progress: DownloadProgress) => void,
) => Promise<void>;

export type DiskSpaceProbe = (path: string) => { freeBytes: number };

export type ProvisioningDeps = {
  transportFor?: (tierId: string) => DownloadTransport;
  probeDiskSpace?: DiskSpaceProbe;
  now?: () => Date;
};

export class ProvisioningError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

const registry = new Map<string, TierDownloadStatus>();
const completions = new Map<string, Promise<void>>();

export function resetProvisioningRegistryForTests() {
  registry.clear();
  completions.clear();
}

// Staging cleanup: remove the per-tier staging dir and its parent when empty,
// so a finished or failed run leaves no .provisioning residue behind.
function clearStaging(root: string, tierId: string) {
  rmSync(join(root, ".provisioning", tierId), { recursive: true, force: true });
  try {
    rmdirSync(join(root, ".provisioning"));
  } catch {
    // Non-empty or already gone: either way there is nothing to clean.
  }
}

export function waitForTierDownload(tierId: string) {
  return completions.get(tierId) ?? Promise.resolve();
}

function modelRoot() {
  return (
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR?.trim() ||
    join(process.cwd(), "models")
  );
}

function defaultDiskSpaceProbe(path: string) {
  const stats = statfsSync(path);
  return { freeBytes: Number(stats.bavail) * Number(stats.bsize) };
}

function idleStatus(tierId: string): TierDownloadStatus {
  return {
    tierId,
    state: "idle",
    bytesReceived: 0,
    bytesTotal: TIER_DOWNLOADS[tierId].sizeBytes,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

export type ModelTierProvisioningView = {
  tierId: string;
  available: boolean;
  downloadSizeBytes: number;
  download: Pick<
    TierDownloadStatus,
    "state" | "bytesReceived" | "bytesTotal" | "error"
  >;
};

export function listProvisioningStatus(): {
  activeTierId: string | null;
  tiers: ModelTierProvisioningView[];
} {
  let activeTierId: string | null = null;
  const tiers = MODEL_TIER_IDS.map((tierId) => {
    const available = isModelProvisioned(tierId);
    const record = registry.get(tierId);
    if (record?.state === "downloading") {
      activeTierId = tierId;
    }
    // Hand-provisioned artifacts (e.g. an operator rsync) and registry bytes
    // reconcile to one honest answer: available means completed unless a
    // download is literally in flight right now.
    const state: TierDownloadState =
      record?.state === "downloading"
        ? "downloading"
        : available
          ? "completed"
          : (record?.state ?? "idle");
    return {
      tierId,
      available,
      downloadSizeBytes: TIER_DOWNLOADS[tierId].sizeBytes,
      download: {
        state,
        bytesReceived: record?.bytesReceived ?? 0,
        bytesTotal: record?.bytesTotal ?? TIER_DOWNLOADS[tierId].sizeBytes,
        error: state === "failed" ? (record?.error ?? "Download failed.") : null,
      },
    } satisfies ModelTierProvisioningView;
  });

  return { activeTierId, tiers };
}

function fixtureDirForTier(tierId: string): string | null {
  const root = process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR?.trim();
  if (!root) {
    return null;
  }
  const dir = join(root, tierId);
  const complete = TIER_DOWNLOADS[tierId].files.every((file) => existsSync(join(dir, file)));
  return complete ? dir : null;
}

const FIXTURE_COPY_CHUNK_BYTES = 1024 * 1024;
// The fixture transport paces its copies so e2e lanes and demos actually
// observe the progress surface instead of an instant flash; the real HTTP
// transport never delays.
const FIXTURE_CHUNK_DELAY_MS = 250;

async function writeChunks(
  chunks: AsyncIterable<Buffer>,
  destination: string,
  onChunk: (chunk: Buffer) => void,
  paceMs = 0,
) {
  const write = createWriteStream(destination);
  try {
    for await (const chunk of chunks) {
      if (!write.write(chunk)) {
        await once(write, "drain");
      }
      onChunk(chunk);
      if (paceMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, paceMs));
      }
    }
    write.end();
    await once(write, "finish");
  } catch (error) {
    write.destroy();
    throw error;
  }
}

function fixtureTransport(fixtureDir: string): DownloadTransport {
  return async (url, destination, onProgress) => {
    const file = url.split("/").pop();
    if (!file) {
      throw new Error(`Cannot resolve a fixture file name from ${url}.`);
    }
    const sourcePath = join(fixtureDir, file);
    const { size } = await stat(sourcePath);
    let received = 0;
    const read = createReadStream(sourcePath, { highWaterMark: FIXTURE_COPY_CHUNK_BYTES });
    try {
      await writeChunks(
        read,
        destination,
        (chunk) => {
          received += chunk.byteLength;
          onProgress({ bytesReceived: received, bytesTotal: size });
        },
        FIXTURE_CHUNK_DELAY_MS,
      );
    } catch (error) {
      read.destroy();
      throw error;
    }
  };
}

// Ceiling per file: catches genuinely wedged sockets without capping slow
// links mid-progress (fetch streams otherwise run unbounded).
const FILE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

async function httpTransport(
  url: string,
  destination: string,
  onProgress: (progress: DownloadProgress) => void,
) {
  if (!url.startsWith(`${HUGGINGFACE_DOWNLOAD_BASE_URL}/`)) {
    throw new Error(`Refusing to download model artifacts from a non-pinned URL: ${url}`);
  }
  const response = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download of ${url} failed with HTTP ${response.status}.`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  const body = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  try {
    await writeChunks(body as AsyncIterable<Buffer>, destination, (chunk) => {
      received += chunk.byteLength;
      onProgress({ bytesReceived: received, bytesTotal: total });
    });
  } catch (error) {
    body.destroy();
    throw error;
  }
  if (total > 0 && received !== total) {
    throw new Error(
      `Download of ${url} was truncated (${received} of ${total} bytes received).`,
    );
  }
}

function defaultTransportFor(tierId: string): DownloadTransport {
  const fixtureDir = fixtureDirForTier(tierId);
  return fixtureDir ? fixtureTransport(fixtureDir) : httpTransport;
}

function updateRegistry(tierId: string, patch: Partial<TierDownloadStatus>) {
  const current = registry.get(tierId);
  if (!current) {
    return;
  }
  registry.set(tierId, { ...current, ...patch });
}

async function runDownload(tierId: string, deps: ProvisioningDeps) {
  const root = modelRoot();
  const stagingDir = join(root, ".provisioning", tierId);
  const targetDir = join(root, tierId);
  const transportFor = deps.transportFor ?? defaultTransportFor;

  try {
    clearStaging(root, tierId);
    mkdirSync(stagingDir, { recursive: true });

    const urls = modelTierDownloadUrls(tierId);
    const transport = transportFor(tierId);
    let completedBytes = 0;
    for (const url of urls) {
      const file = url.split("/").pop() as string;
      await transport(url, join(stagingDir, file), (progress) => {
        updateRegistry(tierId, {
          // The denominator stays the pinned tier size: known before the
          // first byte and stable across per-file content-length reports.
          bytesReceived: completedBytes + progress.bytesReceived,
        });
      });
      const stagedSize = (await stat(join(stagingDir, file))).size;
      completedBytes += stagedSize;
      updateRegistry(tierId, { bytesReceived: completedBytes, bytesTotal: TIER_DOWNLOADS[tierId].sizeBytes });
    }

    // Reveal the tier directory: model.bin lands LAST because the catalog
    // gate (and the picker) treat model.bin + config.json as the provisioned
    // signal.
    if (isModelProvisioned(tierId)) {
      clearStaging(root, tierId);
      updateRegistry(tierId, {
        state: "completed",
        finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
        bytesReceived: TIER_DOWNLOADS[tierId].sizeBytes,
        bytesTotal: TIER_DOWNLOADS[tierId].sizeBytes,
        error: null,
      });
      return;
    }

    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    const filesInRevealOrder = [
      ...TIER_DOWNLOADS[tierId].files.filter((file) => file !== "model.bin"),
      "model.bin",
    ];
    for (const file of filesInRevealOrder) {
      renameSync(join(stagingDir, file), join(targetDir, file));
    }
    clearStaging(root, tierId);

    if (!isModelProvisioned(tierId)) {
      throw new Error(
        "The download completed but the installed artifacts do not form a runnable faster-whisper layout.",
      );
    }

    console.info(`Model download completed for tier '${tierId}' in ${targetDir}.`);
    updateRegistry(tierId, {
      state: "completed",
      finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
      error: null,
    });
  } catch (error) {
    clearStaging(root, tierId);
    // Never leave a half-written tier directory for the catalog to trip on.
    if (!isModelProvisioned(tierId)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Model download for tier '${tierId}' failed: ${message}`);
    updateRegistry(tierId, {
      state: "failed",
      error: message,
      finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
    });
  }
}

export function startTierDownload(
  tierId: string,
  deps: ProvisioningDeps = {},
): TierDownloadStatus {
  if (!MODEL_TIER_IDS.includes(tierId) || !TIER_DOWNLOADS[tierId]) {
    throw new ProvisioningError(
      400,
      "unknown_model_tier",
      `Unknown transcription model tier '${tierId}'.`,
    );
  }

  if (isModelProvisioned(tierId)) {
    throw new ProvisioningError(
      409,
      "tier_already_provisioned",
      `Transcription model tier '${tierId}' is already provisioned on this host.`,
    );
  }

  const active = listProvisioningStatus().activeTierId;
  if (active) {
    throw new ProvisioningError(
      409,
      "download_in_progress",
      `A model download is already in progress for tier '${active}'. Wait for it to finish before starting another.`,
      { activeTierId: active },
    );
  }

  const root = modelRoot();
  mkdirSync(root, { recursive: true });
  const probe = deps.probeDiskSpace ?? defaultDiskSpaceProbe;
  const requiredBytes = Math.ceil(TIER_DOWNLOADS[tierId].sizeBytes * DISK_SPACE_HEADROOM);
  const { freeBytes } = probe(root);
  if (freeBytes < requiredBytes) {
    throw new ProvisioningError(
      507,
      "insufficient_disk_space",
      `Not enough free disk space to install the '${tierId}' model: the download needs about ${Math.ceil(requiredBytes / (1024 * 1024))} MiB but only ${Math.floor(freeBytes / (1024 * 1024))} MiB are free under ${root}.`,
      { requiredBytes, freeBytes, modelRoot: root },
    );
  }

  const startedAt = (deps.now ?? (() => new Date()))().toISOString();
  console.info(
    `Model download started for tier '${tierId}' into ${root} (fixture seam: ${fixtureDirForTier(tierId) ? "on" : "off"}).`,
  );
  const status: TierDownloadStatus = {
    tierId,
    state: "downloading",
    bytesReceived: 0,
    bytesTotal: TIER_DOWNLOADS[tierId].sizeBytes,
    error: null,
    startedAt,
    finishedAt: null,
  };
  registry.set(tierId, status);

  const completion = runDownload(tierId, deps).catch((error) => {
    // runDownload handles its own failure accounting; this guard only keeps
    // the background task from surfacing as an unhandled rejection.
    console.error(`Model download for tier '${tierId}' failed unexpectedly:`, error);
  });
  completions.set(tierId, completion);

  return status;
}
