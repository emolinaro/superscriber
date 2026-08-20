import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  lstatSync,
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
  modelTierOptionalDownloadUrls,
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

function reclaimPath(root: string) {
  return `${lockPath(root)}.reclaim`;
}

function reclaimOwnerPath(root: string) {
  const path = reclaimPath(root);
  try {
    return lstatSync(path).isDirectory()
      ? join(path, LOCK_OWNER_FILE_NAME)
      : path;
  } catch {
    return path;
  }
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

function readOwnerFile(path: string): ProvisioningLockOwner | null {
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
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

function readLockOwner(root: string) {
  if (pathIsSymbolicLink(lockPath(root))) return null;
  return readOwnerFile(lockOwnerPath(root));
}

function readReclaimOwner(root: string) {
  if (pathIsSymbolicLink(reclaimPath(root))) return null;
  return readOwnerFile(reclaimOwnerPath(root));
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
  if (
    current?.token === owner.token &&
    current.pid === owner.pid &&
    current.processStart === owner.processStart
  ) {
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

function pathGenerationSnapshot(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function reclaimSlotIsOwned(root: string, owner: ProvisioningLockOwner) {
  const current = readReclaimOwner(root);
  return (
    current?.token === owner.token &&
    current.pid === owner.pid &&
    current.processStart === owner.processStart &&
    processOwnsLock(current)
  );
}

function releaseReclaimSlot(root: string, owner: ProvisioningLockOwner) {
  if (!reclaimSlotIsOwned(root, owner)) return;
  const path = reclaimPath(root);
  const releasedPath = `${path}.released.${owner.pid}.${owner.token}`;
  try {
    renameSync(path, releasedPath);
    rmSync(releasedPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function staleReclaimSlotCanBeMoved(root: string) {
  const path = reclaimPath(root);
  const owner = readReclaimOwner(root);
  if (owner && processOwnsLock(owner)) return false;
  try {
    return Date.now() - statSync(path).mtimeMs >= LOCK_INITIALIZATION_GRACE_MS;
  } catch {
    return true;
  }
}

function moveStaleReclaimSlot(root: string) {
  const path = reclaimPath(root);
  if (!staleReclaimSlotCanBeMoved(root)) return false;
  const observed = pathGenerationSnapshot(reclaimOwnerPath(root));
  const stalePath = `${path}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  const movedOwnerPath = lstatSync(stalePath).isDirectory()
    ? join(stalePath, LOCK_OWNER_FILE_NAME)
    : stalePath;
  const moved = pathGenerationSnapshot(movedOwnerPath);
  const movedOwner = readOwnerFile(movedOwnerPath);
  if (moved === observed && (!movedOwner || !processOwnsLock(movedOwner))) {
    rmSync(stalePath, { recursive: true, force: true });
    return true;
  }
  if (!existsSync(path)) {
    try {
      renameSync(stalePath, path);
    } catch {}
  }
  return false;
}

function acquireReclaimSlot(root: string, tierId: string) {
  const path = reclaimPath(root);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const processStart = processStartIdentity(process.pid);
    if (!processStart) throw new Error("could not identify the reclaim process");
    const owner: ProvisioningLockOwner = {
      pid: process.pid,
      processStart,
      tierId,
      token: randomBytes(24).toString("hex"),
      createdAt: new Date().toISOString(),
    };
    const privatePath = `${path}.pending.${owner.pid}.${owner.token}`;
    const privateOwnerPath = join(privatePath, LOCK_OWNER_FILE_NAME);
    try {
      if (pathIsSymbolicLink(path)) {
        throw new Error(`Provisioning reclaim path is a symlink: ${path}`);
      }
      mkdirSync(privatePath, { mode: 0o700 });
      writeFileSync(privateOwnerPath, JSON.stringify(owner), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      linkSync(privateOwnerPath, path);
      rmSync(privatePath, { recursive: true, force: true });
      return owner;
    } catch (error) {
      rmSync(privatePath, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readReclaimOwner(root);
      if (owner && processOwnsLock(owner)) return null;
      if (!moveStaleReclaimSlot(root)) return null;
    }
  }
  return null;
}

function reclaimStaleProvisioningLock(
  root: string,
  observed: string,
  tierId: string,
) {
  const path = lockPath(root);
  const reclaimOwner = acquireReclaimSlot(root, tierId);
  if (!reclaimOwner) return false;

  const current = lockGenerationSnapshot(root);
  if (
    current !== observed ||
    liveLockOwner(root) ||
    !reclaimSlotIsOwned(root, reclaimOwner)
  ) {
    releaseReclaimSlot(root, reclaimOwner);
    return false;
  }

  if (
    lockGenerationSnapshot(root) !== observed ||
    liveLockOwner(root) ||
    !reclaimSlotIsOwned(root, reclaimOwner)
  ) {
    releaseReclaimSlot(root, reclaimOwner);
    return false;
  }
  const stalePath = `${path}.stale.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, stalePath);
    rmSync(stalePath, { recursive: true, force: true });
    releaseReclaimSlot(root, reclaimOwner);
    return true;
  } catch (error) {
    releaseReclaimSlot(root, reclaimOwner);
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
    let privatePath = "";
    try {
      if (existsSync(reclaimPath(root)) || pathIsSymbolicLink(reclaimPath(root))) {
        const reclaimOwner = readReclaimOwner(root);
        if (!reclaimOwner || !processOwnsLock(reclaimOwner)) {
          moveStaleReclaimSlot(root);
        }
      }
      if (existsSync(reclaimPath(root)) || pathIsSymbolicLink(reclaimPath(root))) {
        const error = new Error("provisioning lock reclamation is in progress") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      if (existsSync(path) || pathIsSymbolicLink(path)) {
        const error = new Error("provisioning lock already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
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
      privatePath = `${path}.pending.${owner.pid}.${owner.token}`;
      mkdirSync(privatePath, { mode: 0o700 });
      writeFileSync(
        join(privatePath, LOCK_OWNER_FILE_NAME),
        JSON.stringify(owner),
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      if (existsSync(path) || pathIsSymbolicLink(path)) {
        const error = new Error("provisioning lock already exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      renameSync(privatePath, path);
      privatePath = "";
      return owner;
    } catch (error) {
      if (privatePath) rmSync(privatePath, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") {
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
      reclaimStaleProvisioningLock(root, observed, tierId);
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

function pathIsSymbolicLink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeModelPaths(root: string, tierId: string) {
  const protectedPaths = [
    root,
    join(root, tierId),
    join(root, ".provisioning"),
    lockPath(root),
    reclaimPath(root),
    ...TIER_DOWNLOADS[tierId].files.map((file) => join(root, tierId, file)),
  ];
  const unsafe = protectedPaths.find(pathIsSymbolicLink);
  if (unsafe) {
    throw new ProvisioningError(
      409,
      "unsafe_model_path",
      `Model provisioning refuses the symbolic link at ${unsafe}. Replace it with storage inside the configured model directory.`,
      { modelRoot: root, unsafePath: unsafe },
    );
  }
  try {
    if (!lstatSync(root).isDirectory()) {
      throw new ProvisioningError(
        409,
        "unsafe_model_path",
        `Model provisioning requires a real directory at ${root}.`,
        { modelRoot: root, unsafePath: root },
      );
    }
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  let publishedTarget = false;
  let publishedIdentity: { dev: bigint; ino: bigint } | null = null;

  try {
    assertSafeModelPaths(root, tierId);
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

    // Best-effort extras the availability gate never requires (today: the
    // v3 family's preprocessor_config.json). They must follow the pinned
    // shape when present; any transport or size mismatch just skips them -
    // the worker derives its audio frontend from the loaded model itself, so
    // an incomplete extra can never wedge the tier again (see the
    // mel-bins-mismatch note in tier-downloads.ts).
    const optionalSizes = TIER_DOWNLOADS[tierId].optionalFileSizeBytes;
    for (const url of modelTierOptionalDownloadUrls(tierId)) {
      const file = url.split("/").pop() as string;
      const destination = join(stagingDir, file);
      try {
        await transport(url, destination, () => {});
        if ((await stat(destination)).size !== optionalSizes[file]) {
          rmSync(destination, { force: true });
        }
      } catch {
        rmSync(destination, { force: true });
      }
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

    assertSafeModelPaths(root, tierId);
    if (existsSync(targetDir)) {
      const targetIdentity = lstatSync(targetDir, { bigint: true });
      if (!targetIdentity.isDirectory()) {
        throw new ProvisioningError(
          409,
          "unsafe_model_path",
          `Model provisioning refuses the non-directory target at ${targetDir}.`,
          { modelRoot: root, unsafePath: targetDir },
        );
      }
      rmSync(targetDir, { recursive: true, force: true });
    }
    renameSync(stagingDir, targetDir);
    publishedTarget = true;
    const targetIdentity = lstatSync(targetDir, { bigint: true });
    publishedIdentity = { dev: targetIdentity.dev, ino: targetIdentity.ino };
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
    if (publishedTarget && publishedIdentity && !pathIsSymbolicLink(targetDir)) {
      try {
        const current = lstatSync(targetDir, { bigint: true });
        if (
          current.dev === publishedIdentity.dev &&
          current.ino === publishedIdentity.ino
        ) {
          removeDirectory(targetDir);
        }
      } catch {}
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
  assertSafeModelPaths(root, tierId);

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
