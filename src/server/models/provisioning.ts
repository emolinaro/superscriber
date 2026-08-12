import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

import { isModelProvisioned, MODEL_TIER_IDS } from "./catalog";
import {
  HUGGINGFACE_DOWNLOAD_BASE_URL,
  modelTierDownloadUrls,
  TIER_DOWNLOADS,
} from "./tier-downloads";

// model-tier-provisioning: server-side tier installs for the ingest picker.
// A download stages the pinned faster-whisper artifact set under
// "<modelRoot>/.provisioning/<tier>-<owner>/" and only then reveals
// "<modelRoot>/<tier>/" with a directory rename, so the catalog can never
// observe a half-written tier. Failures delete both staging and target directories and stay on
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

type ProvisioningLockOwner = {
  pid: number;
  processStart: string;
  tierId: string;
  token: string;
  createdAt: string;
};

const LOCK_DIRECTORY_NAME = ".provisioning.lock";
const LOCK_OWNER_FILE_NAME = "owner.json";
const LOCK_INITIALIZATION_GRACE_MS = 5_000;

function lockPath(root: string) {
  return join(root, LOCK_DIRECTORY_NAME);
}

function lockOwnerPath(root: string) {
  return join(lockPath(root), LOCK_OWNER_FILE_NAME);
}

function processStartIdentity(pid: number) {
  try {
    const identity = execFileSync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "args="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!identity) return null;
    return createHash("sha256").update(identity).digest("hex");
  } catch {
    return null;
  }
}

function readLockOwner(root: string): ProvisioningLockOwner | null {
  try {
    const parsed = JSON.parse(
      readFileSync(lockOwnerPath(root), "utf8"),
    ) as Partial<ProvisioningLockOwner>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.processStart !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.processStart) ||
      typeof parsed.tierId !== "string" ||
      !MODEL_TIER_IDS.includes(parsed.tierId) ||
      typeof parsed.token !== "string" ||
      !/^[0-9a-f]{48}$/.test(parsed.token) ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed as ProvisioningLockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processOwnsLock(owner: ProvisioningLockOwner) {
  return (
    processIsAlive(owner.pid) &&
    processStartIdentity(owner.pid) === owner.processStart
  );
}

function liveLockOwner(root: string) {
  const owner = readLockOwner(root);
  return owner && processOwnsLock(owner) ? owner : null;
}

function releaseProvisioningLock(root: string, owner: ProvisioningLockOwner) {
  const current = readLockOwner(root);
  if (current?.token === owner.token) {
    const stalePath = `${lockPath(root)}.released.${owner.pid}.${owner.token}`;
    try {
      renameSync(lockPath(root), stalePath);
      rmSync(stalePath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function lockGenerationSnapshot(root: string) {
  try {
    return readFileSync(lockOwnerPath(root), "utf8");
  } catch {
    return "";
  }
}

function removeReclaimSlot(root: string) {
  try {
    rmdirSync(join(lockPath(root), ".reclaim"));
  } catch {}
}

function reclaimStaleProvisioningLock(root: string, observed: string) {
  const path = lockPath(root);
  const reclaimPath = join(path, ".reclaim");
  try {
    mkdirSync(reclaimPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        if (
          Date.now() - statSync(reclaimPath).mtimeMs >=
          LOCK_INITIALIZATION_GRACE_MS
        ) {
          rmSync(reclaimPath, { recursive: true, force: true });
        }
      } catch {}
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  const current = lockGenerationSnapshot(root);
  if (current !== observed || liveLockOwner(root)) {
    removeReclaimSlot(root);
    return false;
  }

  const stalePath = `${path}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, stalePath);
    rmSync(stalePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    removeReclaimSlot(root);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function acquireProvisioningLock(
  root: string,
  tierId: string,
): ProvisioningLockOwner {
  const path = lockPath(root);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let createdLock = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      createdLock = true;
      const processStart = processStartIdentity(process.pid);
      if (!processStart) {
        throw new Error("could not identify the provisioning process");
      }
      const owner: ProvisioningLockOwner = {
        pid: process.pid,
        processStart,
        tierId,
        token: randomBytes(24).toString("hex"),
        createdAt: new Date().toISOString(),
      };
      writeFileSync(lockOwnerPath(root), JSON.stringify(owner), {
        encoding: "utf8",
        mode: 0o600,
      });
      return owner;
    } catch (error) {
      if (createdLock) {
        rmSync(path, { recursive: true, force: true });
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new ProvisioningError(
          500,
          "model_root_unwritable",
          `The model directory ${root} cannot acquire its provisioning lock: ${error instanceof Error ? error.message : String(error)}`,
          { modelRoot: root },
        );
      }

      const active = liveLockOwner(root);
      if (active) {
        throw new ProvisioningError(
          409,
          "download_in_progress",
          `A model download is already in progress for tier '${active.tierId}'. Wait for it to finish before starting another.`,
          { activeTierId: active.tierId },
        );
      }

      const owner = readLockOwner(root);
      if (!owner) {
        try {
          if (
            Date.now() - statSync(path).mtimeMs <
            LOCK_INITIALIZATION_GRACE_MS
          ) {
            throw new ProvisioningError(
              409,
              "download_in_progress",
              "A model download is acquiring the provisioning lock. Wait for it to finish before starting another.",
            );
          }
        } catch (statError) {
          if (statError instanceof ProvisioningError) throw statError;
        }
      }

      const observed = lockGenerationSnapshot(root);
      reclaimStaleProvisioningLock(root, observed);
    }
  }
  throw new ProvisioningError(
    409,
    "download_in_progress",
    "A model download is already acquiring the provisioning lock.",
  );
}

export function resetProvisioningRegistryForTests() {
  registry.clear();
  completions.clear();
}

// Staging cleanup: remove the per-tier staging dir and its parent when empty,
// so a finished or failed run leaves no .provisioning residue behind.
function removeDirectory(path: string) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    return;
  }
}

function clearStaging(root: string, stagingDir: string) {
  removeDirectory(stagingDir);
  try {
    rmdirSync(join(root, ".provisioning"));
  } catch {}
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
  let activeTierId: string | null = liveLockOwner(modelRoot())?.tierId ?? null;
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
      record?.state === "downloading" || (activeTierId === tierId && !available)
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
        error:
          state === "failed" ? (record?.error ?? "Download failed.") : null,
      },
    } satisfies ModelTierProvisioningView;
  });

  return { activeTierId, tiers };
}

function fixtureDirForTier(tierId: string): string | null {
  const root = process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR?.trim();
  const source = TIER_DOWNLOADS[tierId];
  if (!root || !source) {
    return null;
  }
  const dir = join(root, tierId);
  const complete = source.files.every((file) => existsSync(join(dir, file)));
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
    const read = createReadStream(sourcePath, {
      highWaterMark: FIXTURE_COPY_CHUNK_BYTES,
    });
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

const FILE_DOWNLOAD_STALL_TIMEOUT_MS = 90 * 1000;

async function httpTransport(
  url: string,
  destination: string,
  onProgress: (progress: DownloadProgress) => void,
) {
  if (!url.startsWith(`${HUGGINGFACE_DOWNLOAD_BASE_URL}/`)) {
    throw new Error(
      `Refusing to download model artifacts from a non-pinned URL: ${url}`,
    );
  }
  const controller = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let body: Readable | undefined;
  const resetStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
    }
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, FILE_DOWNLOAD_STALL_TIMEOUT_MS);
  };
  resetStallTimer();
  try {
    const response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Download of ${url} failed with HTTP ${response.status}.`,
      );
    }
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    body = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    async function* trackActivity(chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        resetStallTimer();
        yield chunk;
      }
    }
    await writeChunks(
      trackActivity(body as AsyncIterable<Buffer>),
      destination,
      (chunk) => {
        received += chunk.byteLength;
        onProgress({ bytesReceived: received, bytesTotal: total });
      },
    );
    if (total > 0 && received !== total) {
      throw new Error(
        `Download of ${url} was truncated (${received} of ${total} bytes received).`,
      );
    }
  } catch (error) {
    body?.destroy();
    if (stalled) {
      throw new Error(
        `Download of ${url} stalled for 90 seconds without receiving data.`,
      );
    }
    throw error;
  } finally {
    if (stallTimer) {
      clearTimeout(stallTimer);
    }
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

async function runDownload(
  tierId: string,
  deps: ProvisioningDeps,
  lockOwner: ProvisioningLockOwner,
) {
  const root = modelRoot();
  const stagingDir = join(
    root,
    ".provisioning",
    `${tierId}-${lockOwner.pid}-${lockOwner.token}`,
  );
  const targetDir = join(root, tierId);
  const transportFor = deps.transportFor ?? defaultTransportFor;

  try {
    removeDirectory(join(root, ".provisioning"));
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
      updateRegistry(tierId, {
        bytesReceived: completedBytes,
        bytesTotal: TIER_DOWNLOADS[tierId].sizeBytes,
      });
    }

    if (isModelProvisioned(tierId)) {
      clearStaging(root, stagingDir);
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
    renameSync(stagingDir, targetDir);
    clearStaging(root, stagingDir);

    if (!isModelProvisioned(tierId)) {
      throw new Error(
        "The download completed but the installed artifacts do not form a runnable faster-whisper layout.",
      );
    }

    console.info(
      `Model download completed for tier '${tierId}' in ${targetDir}.`,
    );
    updateRegistry(tierId, {
      state: "completed",
      finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateRegistry(tierId, {
      state: "failed",
      error: message,
      finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
    });
    clearStaging(root, stagingDir);
    if (!isModelProvisioned(tierId)) {
      removeDirectory(targetDir);
    }
    console.error(`Model download for tier '${tierId}' failed: ${message}`);
  } finally {
    releaseProvisioningLock(root, lockOwner);
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
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new ProvisioningError(
      500,
      "model_root_unwritable",
      `The model directory ${root} cannot be created or written: ${error instanceof Error ? error.message : String(error)}`,
      { modelRoot: root },
    );
  }
  const lockOwner = acquireProvisioningLock(root, tierId);
  if (isModelProvisioned(tierId)) {
    releaseProvisioningLock(root, lockOwner);
    throw new ProvisioningError(
      409,
      "tier_already_provisioned",
      `Transcription model tier '${tierId}' is already provisioned on this host.`,
    );
  }
  const probe = deps.probeDiskSpace ?? defaultDiskSpaceProbe;
  try {
    const requiredBytes = Math.ceil(
      TIER_DOWNLOADS[tierId].sizeBytes * DISK_SPACE_HEADROOM,
    );
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

    const completion = runDownload(tierId, deps, lockOwner).catch((error) => {
      console.error(
        `Model download for tier '${tierId}' failed unexpectedly:`,
        error,
      );
    });
    completions.set(tierId, completion);

    return status;
  } catch (error) {
    releaseProvisioningLock(root, lockOwner);
    throw error;
  }
}
