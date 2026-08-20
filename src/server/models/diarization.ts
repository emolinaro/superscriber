import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";

import bundlePins from "../../../worker/diarization-bundle.json";
import { HUGGINGFACE_DOWNLOAD_BASE_URL } from "./tier-downloads";

// diarization-bundle (captain engine ruling 2026-08-20, option A): the
// vendored pyannote speaker-diarization-3.1 bundle. The three source repos
// sit behind a Hugging Face click-gate: provisioning fetches the pinned
// files once per home, using a personal HF token supplied for that run only
// (SUPERSCRIBER_HUGGINGFACE_TOKEN or HF_TOKEN env - never persisted), and the
// runtime afterwards reads this local byte cache with zero network access.
//
// Single source of truth for the pins: worker/diarization-bundle.json, read
// by BOTH this module (bootstrap/lane bootstrap path) and the Python worker
// prefetcher (image build path), so the two installers can never drift.
//
// Install layout under the shared model root:
//   <modelRoot>/diarization/config.yaml                     (pipeline config)
//   <modelRoot>/diarization/segmentation/{config,weights}
//   <modelRoot>/diarization/embedding/{config,weights}
//
// The fixture seam matches model-tier provisioning:
// SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR/diarization/<relative path> with
// the complete file set copies from disk instead of fetching, so e2e lanes
// without network (or without an HF token) can drive the full installer.

export type DiarizationBundleFile = { path: string; sizeBytes: number };

export type DiarizationBundlePart = {
  repository: string;
  revision: string;
  files: DiarizationBundleFile[];
};

export const DIARIZATION_BUNDLE = bundlePins as {
  bundleId: string;
  parts: {
    pipeline: DiarizationBundlePart;
    segmentation: DiarizationBundlePart;
    embedding: DiarizationBundlePart;
  };
  sizeBytes: number;
};

export const DIARIZATION_BUNDLE_DIR_NAME = "diarization";

function modelRoot() {
  return (
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR?.trim() ||
    join(process.cwd(), "models")
  );
}

export function diarizationBundleRoot(root = modelRoot()) {
  return join(root, DIARIZATION_BUNDLE_DIR_NAME);
}

export function allBundleFiles(): DiarizationBundleFile[] {
  const parts = Object.values(DIARIZATION_BUNDLE.parts);
  return parts.flatMap((part) => part.files);
}

function bundleErrorMessage(token: string | null, cause: string) {
  if (token) {
    return `The diarization bundle download failed (${cause}). A gated 401 means the HF account behind the token must still accept the click-gate on pyannote/segmentation-3.0 and pyannote/speaker-diarization-3.1. See docs/operators/diarization.md.`;
  }
  return `The diarization bundle requires a one-time Hugging Face gated download but no token was provided. Visit https://huggingface.co/pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0, accept the gate once, then re-run provisioning with SUPERSCRIBER_HUGGINGFACE_TOKEN (or HF_TOKEN) set for that run only. See docs/operators/diarization.md.`;
}

export function huggingfaceToken(): string | null {
  const token =
    process.env.SUPERSCRIBER_HUGGINGFACE_TOKEN?.trim() ||
    process.env.HF_TOKEN?.trim();
  return token || null;
}

export function isDiarizationBundleProvisioned(root = modelRoot()): boolean {
  const dir = diarizationBundleRoot(root);
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  return allBundleFiles().every((file) => {
    try {
      const artifact = lstatSync(join(dir, file.path));
      return (
        artifact.isFile() &&
        !artifact.isSymbolicLink() &&
        artifact.size === file.sizeBytes
      );
    } catch {
      return false;
    }
  });
}

export function bundleDownloadUrls(): { url: string; path: string; sizeBytes: number }[] {
  const downloads: { url: string; path: string; sizeBytes: number }[] = [];
  for (const part of Object.values(DIARIZATION_BUNDLE.parts)) {
    for (const file of part.files) {
      // The ensemble installs part files under the bundle-local path, which
      // happens to be the final path segment(s); the remote repo stores the
      // plain filename.
      const remoteName = file.path.split("/").pop() as string;
      downloads.push({
        url: `${HUGGINGFACE_DOWNLOAD_BASE_URL}/${part.repository}/resolve/${part.revision}/${remoteName}`,
        path: file.path,
        sizeBytes: file.sizeBytes,
      });
    }
  }
  return downloads;
}

function fixtureDirForBundle(): string | null {
  const root = process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR?.trim();
  if (!root) return null;
  const dir = join(root, DIARIZATION_BUNDLE_DIR_NAME);
  const complete = allBundleFiles().every((file) => {
    try {
      const stat = lstatSync(join(dir, file.path));
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size > 0 &&
        stat.size === file.sizeBytes
      );
    } catch {
      return false;
    }
  });
  return complete ? dir : null;
}

const FILE_DOWNLOAD_STALL_TIMEOUT_MS = 90 * 1000;

async function fetchPinnedFile(
  url: string,
  destination: string,
  token: string,
  onBytes: (received: number, total: number) => void,
) {
  if (!url.startsWith(`${HUGGINGFACE_DOWNLOAD_BASE_URL}/`)) {
    throw new Error(`Refusing to download diarization artifacts from a non-pinned URL: ${url}`);
  }
  const controller = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
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
    // The gated repos answer 401 without a token; the token travels on this
    // one request and is never written to disk, logs, or the registry.
    const response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    const write = createWriteStream(destination);
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStallTimer();
        const chunk = Buffer.from(value);
        if (!write.write(chunk)) {
          await once(write, "drain");
        }
        received += chunk.byteLength;
        onBytes(received, total);
      }
      write.end();
      await once(write, "finish");
    } catch (error) {
      write.destroy();
      throw error;
    }
    if (total > 0 && received !== total) {
      throw new Error(
        `Download of ${url} was truncated (${received} of ${total} bytes received).`,
      );
    }
  } catch (error) {
    if (stalled) {
      throw new Error(`Download of ${url} stalled for 90 seconds without receiving data.`);
    }
    throw error;
  } finally {
    if (stallTimer) {
      clearTimeout(stallTimer);
    }
  }
}

export type DiarizationProvisionProgress = {
  bytesReceived: number;
  bytesTotal: number;
};

export type DiarizationProvisionResult = {
  state: "completed" | "failed" | "already_provisioned";
  fixtureSeam: boolean;
  error: string | null;
};

// Stage under <modelRoot>/.diarization-provisioning/ and only then rename the
// complete set into <modelRoot>/diarization/, mirroring the tier flow: an
// interrupted fetch must never look like a usable bundle.
export async function provisionDiarizationBundle(opts: {
  onProgress?: (progress: DiarizationProvisionProgress) => void;
  modelRoot?: string;
}): Promise<DiarizationProvisionResult> {
  const root = opts.modelRoot ?? modelRoot();
  const target = diarizationBundleRoot(root);

  if (isDiarizationBundleProvisioned(root)) {
    return { state: "already_provisioned", fixtureSeam: false, error: null };
  }

  const fixtureDir = fixtureDirForBundle();
  const token = huggingfaceToken();
  if (!fixtureDir && !token) {
    return {
      state: "failed",
      fixtureSeam: false,
      error: bundleErrorMessage(null, ""),
    };
  }

  const staging = join(root, ".diarization-provisioning");
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    const downloads = bundleDownloadUrls();
    let completedBytes = 0;
    for (const download of downloads) {
      const destination = join(staging, download.path);
      mkdirSync(dirname(destination), { recursive: true });
      if (fixtureDir) {
        copyFileSync(join(fixtureDir, download.path), destination);
      } else {
        await fetchPinnedFile(download.url, destination, token as string, (received) =>
          opts.onProgress?.({
            bytesReceived: completedBytes + received,
            bytesTotal: DIARIZATION_BUNDLE.sizeBytes,
          }),
        );
      }
      const stagedSize = statSync(destination).size;
      completedBytes += stagedSize;
      opts.onProgress?.({
        bytesReceived: completedBytes,
        bytesTotal: DIARIZATION_BUNDLE.sizeBytes,
      });
    }

    // Byte-exact verification before the rename makes the bundle observable.
    for (const file of allBundleFiles()) {
      const size = statSync(join(staging, file.path)).size;
      if (size !== file.sizeBytes) {
        throw new Error(
          `Downloaded ${file.path} has ${size} bytes, expected the pinned ${file.sizeBytes}.`,
        );
      }
    }

    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
          `Diarization bundle target ${target} exists and is not a real directory; remove it or pick a different SUPERSCRIBER_TRANSCRIBE_MODEL_DIR.`,
        );
      }
      rmSync(target, { recursive: true, force: true });
    }
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    const cause = error instanceof Error ? error.message : String(error);
    return {
      state: "failed",
      fixtureSeam: Boolean(fixtureDir),
      error:
        fixtureDir || !(error instanceof Error)
          ? cause
          : bundleErrorMessage(token, cause),
    };
  }

  return {
    state: "completed",
    fixtureSeam: Boolean(fixtureDir),
    error: null,
  };
}
