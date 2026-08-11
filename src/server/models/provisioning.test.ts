import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsFaults = vi.hoisted(() => ({
  failTierRemovals: false,
  renameSnapshots: [] as Array<{
    source: string;
    destination: string;
    sourceWasDirectory: boolean;
    destinationExisted: boolean;
  }>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      const [source, destination] = args;
      fsFaults.renameSnapshots.push({
        source: String(source),
        destination: String(destination),
        sourceWasDirectory: actual.statSync(source).isDirectory(),
        destinationExisted: actual.existsSync(destination),
      });
      return actual.renameSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const path = String(args[0]);
      if (
        fsFaults.failTierRemovals &&
        (path.endsWith(join(".provisioning", "tiny")) || path.endsWith(join("", "tiny")))
      ) {
        throw new Error("simulated cleanup failure");
      }
      return actual.rmSync(...args);
    },
  };
});

import {
  DISK_SPACE_HEADROOM,
  listProvisioningStatus,
  ProvisioningError,
  resetProvisioningRegistryForTests,
  startTierDownload,
  waitForTierDownload,
  type DownloadTransport,
} from "./provisioning";
import { TIER_DOWNLOADS } from "./tier-downloads";

// model-tier-provisioning: the server owns tier installs end to end - disk
// preflight, staged download, atomic-ish reveal of the faster-whisper layout -
// and reports every failure honestly instead of leaving a half state.

describe("model provisioning service (model-tier-provisioning)", () => {
  let modelRoot: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    modelRoot = mkdtempSync(join(tmpdir(), "superscriber-provisioning-"));
    savedEnv.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR;
    savedEnv.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR =
      process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR;
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = modelRoot;
    delete process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR;
    resetProvisioningRegistryForTests();
    fsFaults.failTierRemovals = false;
    fsFaults.renameSnapshots.length = 0;
  });

  afterEach(() => {
    for (const key of [
      "SUPERSCRIBER_TRANSCRIBE_MODEL_DIR",
      "SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR",
    ]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(modelRoot, { recursive: true, force: true });
    resetProvisioningRegistryForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function fakeTransport(bytes = 1024): DownloadTransport {
    return async (_url, destination, onProgress) => {
      writeFileSync(destination, Buffer.alloc(bytes, 7));
      onProgress({ bytesReceived: bytes, bytesTotal: bytes });
    };
  }

  function unlimitedDisk() {
    return { freeBytes: Number.MAX_SAFE_INTEGER };
  }

  it("rejects an unknown tier as a 400 validation error", () => {
    expect(() => startTierDownload("not-a-model", { probeDiskSpace: unlimitedDisk })).toThrow(
      ProvisioningError,
    );
    try {
      startTierDownload("not-a-model", { probeDiskSpace: unlimitedDisk });
    } catch (error) {
      const provisioningError = error as ProvisioningError;
      expect(provisioningError.httpStatus).toBe(400);
      expect(provisioningError.code).toBe("unknown_model_tier");
    }
  });

  it("refuses to download an already provisioned tier", () => {
    const dir = join(modelRoot, "tiny");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.bin"), "bin");
    writeFileSync(join(dir, "config.json"), "{}");

    try {
      startTierDownload("tiny", { probeDiskSpace: unlimitedDisk });
      expect.unreachable();
    } catch (error) {
      const provisioningError = error as ProvisioningError;
      expect(provisioningError.httpStatus).toBe(409);
      expect(provisioningError.code).toBe("tier_already_provisioned");
    }
  });

  it("checks disk space before starting and refuses with an honest 507", () => {
    const required = Math.ceil(TIER_DOWNLOADS.tiny.sizeBytes * DISK_SPACE_HEADROOM);
    try {
      startTierDownload("tiny", {
        probeDiskSpace: () => ({ freeBytes: required - 1 }),
      });
      expect.unreachable();
    } catch (error) {
      const provisioningError = error as ProvisioningError;
      expect(provisioningError.httpStatus).toBe(507);
      expect(provisioningError.code).toBe("insufficient_disk_space");
      expect(provisioningError.details).toMatchObject({ requiredBytes: required });
    }
    // No download state may linger after the refused start.
    const status = listProvisioningStatus();
    expect(status.activeTierId).toBeNull();
  });

  it("runs a download to completion and lands the faster-whisper layout", async () => {
    const progress: number[] = [];
    const transport: DownloadTransport = async (url, destination, onProgress) => {
      expect(url).toContain("https://huggingface.co/");
      writeFileSync(destination, Buffer.alloc(3, 1));
      onProgress({ bytesReceived: 1, bytesTotal: 3 });
      onProgress({ bytesReceived: 3, bytesTotal: 3 });
      progress.push(1, 3);
    };

    const status = startTierDownload("tiny", {
      transportFor: () => transport,
      probeDiskSpace: unlimitedDisk,
    });
    expect(status.state).toBe("downloading");
    expect(status.bytesTotal).toBe(TIER_DOWNLOADS.tiny.sizeBytes);

    await waitForTierDownload("tiny");

    const finished = listProvisioningStatus();
    expect(finished.activeTierId).toBeNull();
    const tiny = finished.tiers.find((tier) => tier.tierId === "tiny");
    expect(tiny?.available).toBe(true);
    expect(tiny?.download.state).toBe("completed");
    expect(tiny?.download.error).toBeNull();
    expect(progress.length).toBeGreaterThan(0);

    // The tier directory holds the full faster-whisper layout, and the
    // staging area is gone.
    const tierDir = join(modelRoot, "tiny");
    for (const file of TIER_DOWNLOADS.tiny.files) {
      expect(existsSync(join(tierDir, file))).toBe(true);
    }
    expect(existsSync(join(modelRoot, ".provisioning"))).toBe(false);
  });

  it("reveals a completed tier with one atomic directory rename", async () => {
    const staleTarget = join(modelRoot, "tiny");
    mkdirSync(staleTarget, { recursive: true });
    writeFileSync(join(staleTarget, "stale.txt"), "stale");

    startTierDownload("tiny", {
      transportFor: () => fakeTransport(),
      probeDiskSpace: unlimitedDisk,
    });
    await waitForTierDownload("tiny");

    expect(fsFaults.renameSnapshots).toEqual([
      {
        source: join(modelRoot, ".provisioning", "tiny"),
        destination: join(modelRoot, "tiny"),
        sourceWasDirectory: true,
        destinationExisted: false,
      },
    ]);
    expect(existsSync(join(modelRoot, "tiny", "stale.txt"))).toBe(false);
  });

  it("marks a failed download honestly and keeps the tier unprovisioned", async () => {
    const failing: DownloadTransport = async (url, destination) => {
      if (url.endsWith("model.bin")) {
        throw new Error("network reset mid-file");
      }
      writeFileSync(destination, "ok");
    };

    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    startTierDownload("tiny", {
      transportFor: () => failing,
      probeDiskSpace: unlimitedDisk,
    });
    await waitForTierDownload("tiny");

    const status = listProvisioningStatus();
    const tiny = status.tiers.find((tier) => tier.tierId === "tiny");
    expect(tiny?.available).toBe(false);
    expect(tiny?.download.state).toBe("failed");
    expect(tiny?.download.error).toContain("network reset mid-file");
    expect(status.activeTierId).toBeNull();
    expect(logSpy).toHaveBeenCalled();

    // A failed run leaves no half-populated tier directory behind.
    expect(existsSync(join(modelRoot, "tiny"))).toBe(false);
    expect(existsSync(join(modelRoot, ".provisioning"))).toBe(false);
  });

  it("publishes the original failure when cleanup also fails", async () => {
    const failing: DownloadTransport = async () => {
      fsFaults.failTierRemovals = true;
      throw new Error("network reset mid-file");
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    startTierDownload("tiny", {
      transportFor: () => failing,
      probeDiskSpace: unlimitedDisk,
    });
    await waitForTierDownload("tiny");

    const status = listProvisioningStatus();
    const tiny = status.tiers.find((tier) => tier.tierId === "tiny");
    expect(status.activeTierId).toBeNull();
    expect(tiny?.download.state).toBe("failed");
    expect(tiny?.download.error).toBe("network reset mid-file");
  });

  it("keeps downloading while bytes arrive beyond the former absolute deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 15);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        let timer: ReturnType<typeof setInterval> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let sent = 0;
            const abort = () => {
              if (timer) clearInterval(timer);
              controller.error(new Error("absolute deadline elapsed"));
            };
            signal?.addEventListener("abort", abort, { once: true });
            timer = setInterval(() => {
              controller.enqueue(new Uint8Array([1]));
              sent += 1;
              if (sent === 5) {
                if (timer) clearInterval(timer);
                controller.close();
              }
            }, 5);
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        });
        return new Response(body, {
          headers: { "content-length": "5" },
        });
      }),
    );

    startTierDownload("tiny", { probeDiskSpace: unlimitedDisk });
    await waitForTierDownload("tiny");

    const tiny = listProvisioningStatus().tiers.find((tier) => tier.tierId === "tiny");
    expect(tiny?.available).toBe(true);
    expect(tiny?.download.state).toBe("completed");
  });

  it("fails a download after ninety seconds without a received byte", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30 * 60 * 1000);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(new Error("download aborted")),
              { once: true },
            );
          },
        });
        return new Response(body);
      }),
    );

    startTierDownload("tiny", { probeDiskSpace: unlimitedDisk });
    try {
      await vi.advanceTimersByTimeAsync(90_001);
      const tiny = listProvisioningStatus().tiers.find((tier) => tier.tierId === "tiny");
      expect(tiny?.download.state).toBe("failed");
      expect(tiny?.download.error).toContain("stalled");
    } finally {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await waitForTierDownload("tiny");
    }
  });

  it("permits a retry after a failure", async () => {
    const failing: DownloadTransport = async () => {
      throw new Error("boom");
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    startTierDownload("tiny", { transportFor: () => failing, probeDiskSpace: unlimitedDisk });
    await waitForTierDownload("tiny");

    startTierDownload("tiny", { transportFor: () => fakeTransport(), probeDiskSpace: unlimitedDisk });
    await waitForTierDownload("tiny");

    const tiny = listProvisioningStatus().tiers.find((tier) => tier.tierId === "tiny");
    expect(tiny?.available).toBe(true);
    expect(tiny?.download.state).toBe("completed");
  });

  it("serializes downloads with a 409 while another tier is in flight", async () => {
    let release: () => void = () => undefined;
    let gateOpen = false;
    const blocked: DownloadTransport = async (_url, destination) => {
      if (!gateOpen) {
        // Hold only the FIRST file so the second start attempt reliably sees
        // an in-flight download; releasing lets every file complete.
        await new Promise<void>((resolve) => {
          release = () => {
            gateOpen = true;
            resolve();
          };
        });
      }
      writeFileSync(destination, "x");
    };

    startTierDownload("tiny", { transportFor: () => blocked, probeDiskSpace: unlimitedDisk });
    try {
      startTierDownload("base", { transportFor: () => fakeTransport(), probeDiskSpace: unlimitedDisk });
      expect.unreachable();
    } catch (error) {
      const provisioningError = error as ProvisioningError;
      expect(provisioningError.httpStatus).toBe(409);
      expect(provisioningError.code).toBe("download_in_progress");
    } finally {
      release();
    }
    await waitForTierDownload("tiny");
  });

  it("uses the fixture transport when the seam env var provides the full artifact set", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "superscriber-model-fixture-"));
    const fixtureTier = join(fixtureRoot, "base");
    mkdirSync(fixtureTier, { recursive: true });
    for (const file of TIER_DOWNLOADS.base.files) {
      writeFileSync(join(fixtureTier, file), `fixture-${file}`);
    }
    process.env.SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR = fixtureRoot;

    startTierDownload("base", { probeDiskSpace: unlimitedDisk });
    await waitForTierDownload("base");

    const tierDir = join(modelRoot, "base");
    expect(readFileSync(join(tierDir, "model.bin"), "utf8")).toBe("fixture-model.bin");
    const base = listProvisioningStatus().tiers.find((tier) => tier.tierId === "base");
    expect(base?.available).toBe(true);
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  // chmod-based sealing cannot hold back a root test run (root ignores
  // permission bits), so the case only runs as a regular user.
  it.runIf(typeof process.getuid !== "function" || process.getuid() !== 0)(
    "fails honestly when the model root cannot be created",
    () => {
    const readOnly = join(modelRoot, "sealed");
    mkdirSync(readOnly, { recursive: true });
    chmodSync(readOnly, 0o555);
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = join(readOnly, "models");

    try {
      startTierDownload("tiny", { probeDiskSpace: unlimitedDisk });
      expect.unreachable();
    } catch (error) {
      const provisioningError = error as ProvisioningError;
      expect(provisioningError.code).toBe("model_root_unwritable");
      expect(provisioningError.httpStatus).toBe(500);
      } finally {
        chmodSync(readOnly, 0o755);
      }
    },
  );

  it("reports idle status for untouched tiers and completed for hand-provisioned ones", () => {
    const dir = join(modelRoot, "large-v3-turbo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.bin"), "bin");
    writeFileSync(join(dir, "config.json"), "{}");

    const status = listProvisioningStatus();
    const byId = Object.fromEntries(status.tiers.map((tier) => [tier.tierId, tier]));
    expect(byId["large-v3-turbo"].available).toBe(true);
    expect(byId["large-v3-turbo"].download.state).toBe("completed");
    expect(byId.tiny.available).toBe(false);
    expect(byId.tiny.download.state).toBe("idle");
    expect(byId.tiny.downloadSizeBytes).toBe(TIER_DOWNLOADS.tiny.sizeBytes);
    expect(status.activeTierId).toBeNull();
  });
});
