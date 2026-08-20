import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, truncateSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allBundleFiles,
  bundleDownloadUrls,
  DIARIZATION_BUNDLE,
  diarizationBundleRoot,
  huggingfaceToken,
  isDiarizationBundleProvisioned,
  provisionDiarizationBundle,
} from "./diarization";

// diarization-bundle: installer behavior driven entirely through the fixture
// seam (SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR) on sparse files with the
// pinned byte sizes, so CI never needs network or an HF token.

let tempDir: string;
let savedEnv: Record<string, string | undefined>;

const WATCHED_ENV = [
  "SUPERSCRIBER_TRANSCRIBE_MODEL_DIR",
  "SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR",
  "SUPERSCRIBER_HUGGINGFACE_TOKEN",
  "HF_TOKEN",
];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "diarization-test-"));
  savedEnv = Object.fromEntries(
    WATCHED_ENV.map((name) => [name, process.env[name]]),
  );
  for (const name of WATCHED_ENV) {
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of WATCHED_ENV) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

function createSparseFile(path: string, sizeBytes: number) {
  mkdirSync(dirname(path), { recursive: true });
  // open(2) + truncate keeps the file sparse so these tests stay fast.
  closeSync(openSync(path, "w"));
  truncateSync(path, sizeBytes);
}

function plantFixture(): string {
  const fixtureDir = join(tempDir, "fixture");
  for (const file of allBundleFiles()) {
    createSparseFile(join(fixtureDir, "diarization", file.path), file.sizeBytes);
  }
  return fixtureDir;
}

describe("diarization bundle pins", () => {
  it("pins exactly the three pyannote repos with commit SHAs and byte sizes", () => {
    expect(DIARIZATION_BUNDLE.bundleId).toBe("pyannote-diarization-3.1");
    expect(DIARIZATION_BUNDLE.parts.pipeline.repository).toBe(
      "pyannote/speaker-diarization-3.1",
    );
    expect(DIARIZATION_BUNDLE.parts.segmentation.repository).toBe(
      "pyannote/segmentation-3.0",
    );
    expect(DIARIZATION_BUNDLE.parts.embedding.repository).toBe(
      "pyannote/wespeaker-voxceleb-resnet34-LM",
    );
    for (const part of Object.values(DIARIZATION_BUNDLE.parts)) {
      expect(part.revision).toMatch(/^[0-9a-f]{40}$/);
    }
    const sum = allBundleFiles().reduce((acc, file) => acc + file.sizeBytes, 0);
    expect(sum).toBe(DIARIZATION_BUNDLE.sizeBytes);
    expect(allBundleFiles().map((file) => file.path)).toEqual([
      "config.yaml",
      "segmentation/config.yaml",
      "segmentation/pytorch_model.bin",
      "embedding/config.yaml",
      "embedding/pytorch_model.bin",
    ]);
  });

  it("builds SHA-pinned huggingface.co resolve URLs for every file", () => {
    const downloads = bundleDownloadUrls();
    expect(downloads).toHaveLength(5);
    for (const download of downloads) {
      expect(download.url).toMatch(
        /^https:\/\/huggingface\.co\/pyannote\/[^/]+\/resolve\/[0-9a-f]{40}\/[^/]+$/,
      );
    }
  });
});

describe("isDiarizationBundleProvisioned", () => {
  it("reports an empty model root as not provisioned", () => {
    expect(isDiarizationBundleProvisioned(tempDir)).toBe(false);
  });

  it("reports the byte-complete bundle as provisioned and skips re-downloads", async () => {
    const fixtureDir = plantFixture();
    process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR = fixtureDir;

    const result = await provisionDiarizationBundle({ modelRoot: tempDir });
    expect(result.state).toBe("completed");
    expect(result.fixtureSeam).toBe(true);
    expect(isDiarizationBundleProvisioned(tempDir)).toBe(true);

    // Idempotent: a second run recognizes the installed cache offline.
    delete process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR;
    const again = await provisionDiarizationBundle({ modelRoot: tempDir });
    expect(again.state).toBe("already_provisioned");
  });

  it("rejects a byte-mismatched partial bundle", () => {
    const root = diarizationBundleRoot(tempDir);
    mkdirSync(root, { recursive: true });
    for (const file of allBundleFiles()) {
      createSparseFile(join(root, file.path), file.sizeBytes);
    }
    const first = allBundleFiles()[0];
    execFileSync("truncate", ["-s", "10", join(root, first.path)]);
    expect(isDiarizationBundleProvisioned(tempDir)).toBe(false);
  });
});

describe("provisionDiarizationBundle", () => {
  it("fails with the click-gate instructions when no fixture and no token exist", async () => {
    const result = await provisionDiarizationBundle({ modelRoot: tempDir });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("gated download");
    expect(result.error).toContain("SUPERSCRIBER_HUGGINGFACE_TOKEN");
    expect(isDiarizationBundleProvisioned(tempDir)).toBe(false);
    expect(() => lstatSync(join(tempDir, "diarization"))).toThrow();
  });

  it("keeps no staging residue behind after provisioning", async () => {
    const fixtureDir = plantFixture();
    process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR = fixtureDir;
    const progress: number[] = [];
    const result = await provisionDiarizationBundle({
      modelRoot: tempDir,
      onProgress: ({ bytesReceived }) => progress.push(bytesReceived),
    });
    expect(result.state).toBe("completed");
    expect(progress.at(-1)).toBe(DIARIZATION_BUNDLE.sizeBytes);
    expect(() => lstatSync(join(tempDir, ".diarization-provisioning"))).toThrow();
    const installed = await readFile(join(diarizationBundleRoot(tempDir), "config.yaml"));
    expect(installed.byteLength).toBe(469);
  });

  it("ignores an incomplete fixture directory and asks for a token", async () => {
    const fixtureDir = join(tempDir, "fixture");
    // Plant only the first file: the seam is all-or-nothing.
    const first = allBundleFiles()[0];
    createSparseFile(join(fixtureDir, "diarization", first.path), first.sizeBytes);
    process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR = fixtureDir;
    const result = await provisionDiarizationBundle({ modelRoot: tempDir });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("SUPERSCRIBER_HUGGINGFACE_TOKEN");
  });
});

describe("huggingfaceToken", () => {
  it("prefers the superscriber-scoped token and falls back to HF_TOKEN", () => {
    expect(huggingfaceToken()).toBeNull();
    process.env.HF_TOKEN = "hf_plain";
    expect(huggingfaceToken()).toBe("hf_plain");
    process.env.SUPERSCRIBER_HUGGINGFACE_TOKEN = "hf_scoped";
    expect(huggingfaceToken()).toBe("hf_scoped");
  });
});
