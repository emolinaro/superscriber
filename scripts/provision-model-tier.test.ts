// local-deploy-bootstrap: end-to-end coverage for the operator model-provisioning
// CLI, driven through the repo's fixture download seam
// (SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR) so no network is needed. Verifies
// the same pinned-artifact install path the in-app flow uses: complete file
// set staged, then revealed under <modelRoot>/<tier>/, plus offline-capable
// skip-on-second-run behavior.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TIER_DOWNLOADS } from "@/server/models/tier-downloads";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "provision-model-tier.ts");
const TIER = "tiny";

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync("npx", ["tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

function runCliAsync(args: string[], env: Record<string, string>) {
  const child = spawn("npx", ["tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    child,
    completed: new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolvePromise, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    }),
  };
}

describe("provision-model-tier CLI", () => {
  let testRoot: string | undefined;

  afterEach(() => {
    if (testRoot) {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = undefined;
    }
  });

  function makeFixtureAndModelRoot() {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-provision-test-"));
    const fixtureRoot = join(testRoot, "fixtures");
    const modelRoot = join(testRoot, "models");
    const fixtureDir = join(fixtureRoot, TIER);
    mkdirSync(fixtureDir, { recursive: true });
    for (const file of TIER_DOWNLOADS[TIER].files) {
      writeFileSync(
        join(fixtureDir, file),
        Buffer.alloc(3 * 1024 * 1024, file.length),
      );
    }
    mkdirSync(modelRoot, { recursive: true });
    return { fixtureRoot, modelRoot };
  }

  it("--list prints the known tiers with sizes", { timeout: 120_000 }, () => {
    const { modelRoot } = makeFixtureAndModelRoot();
    const result = runCli(["--list"], {
      SUPERSCRIBER_TRANSCRIBE_MODEL_DIR: modelRoot,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("tiny");
    expect(result.stdout).toContain("large-v3");
    expect(result.stdout).toContain("small");
  });

  it(
    "installs a tier through the pinned-artifact path and skips on re-run",
    { timeout: 240_000 },
    () => {
      const { fixtureRoot, modelRoot } = makeFixtureAndModelRoot();
      const env = {
        SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR: fixtureRoot,
        SUPERSCRIBER_TRANSCRIBE_MODEL_DIR: modelRoot,
      };

      const first = runCli(["--tier", TIER], env);
      expect(first.status, first.stderr + first.stdout).toBe(0);
      expect(first.stdout).toContain("provisioned successfully");
      for (const file of TIER_DOWNLOADS[TIER].files) {
        expect(existsSync(join(modelRoot, TIER, file)), file).toBe(true);
      }
      // Staging must be fully cleaned: the catalog never observes .provisioning.
      expect(existsSync(join(modelRoot, ".provisioning"))).toBe(false);

      const second = runCli(["--tier", TIER], env);
      expect(second.status, second.stderr + second.stdout).toBe(0);
      expect(second.stdout).toContain("already provisioned");
    },
  );

  it("rejects an unknown tier with a usage error", { timeout: 120_000 }, () => {
    const { modelRoot } = makeFixtureAndModelRoot();
    const result = runCli(["--tier", "not-a-tier"], {
      SUPERSCRIBER_TRANSCRIBE_MODEL_DIR: modelRoot,
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("Unknown model tier");
  });

  it(
    "verifies an offline tier without starting a download",
    { timeout: 120_000 },
    () => {
      const { modelRoot } = makeFixtureAndModelRoot();
      const tierDir = join(modelRoot, TIER);
      mkdirSync(tierDir, { recursive: true });
      for (const file of TIER_DOWNLOADS[TIER].files) {
        const artifact = join(tierDir, file);
        writeFileSync(artifact, "artifact");
        truncateSync(artifact, TIER_DOWNLOADS[TIER].fileSizeBytes[file]);
      }
      const result = runCli(["--verify", TIER], {
        SUPERSCRIBER_TRANSCRIBE_MODEL_DIR: modelRoot,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain("available offline");
      expect(existsSync(join(modelRoot, ".provisioning"))).toBe(false);
    },
  );

  it(
    "fails verification when the selected tier is not cached",
    { timeout: 120_000 },
    () => {
      const { modelRoot } = makeFixtureAndModelRoot();
      const result = runCli(["--verify", TIER], {
        SUPERSCRIBER_TRANSCRIBE_MODEL_DIR: modelRoot,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not provisioned");
      expect(existsSync(join(modelRoot, ".provisioning"))).toBe(false);
    },
  );

  it(
    "serializes concurrent stale-lock recovery without clobbering staging",
    { timeout: 240_000 },
    async () => {
      const { fixtureRoot, modelRoot } = makeFixtureAndModelRoot();
      const env = {
        SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR: fixtureRoot,
        SUPERSCRIBER_TRANSCRIBE_MODEL_DIR: modelRoot,
      };
      mkdirSync(join(modelRoot, ".provisioning.lock"));
      writeFileSync(
        join(modelRoot, ".provisioning.lock", "owner.json"),
        JSON.stringify({
          pid: 2_147_483_647,
          processStart: "d".repeat(64),
          tierId: TIER,
          token: "e".repeat(48),
          createdAt: new Date(0).toISOString(),
        }),
      );
      const first = runCliAsync(["--tier", TIER], env);
      const second = runCliAsync(["--tier", TIER], env);
      const [firstResult, secondResult] = await Promise.all([
        first.completed,
        second.completed,
      ]);

      expect(firstResult.status, firstResult.stderr + firstResult.stdout).toBe(
        0,
      );
      expect(
        secondResult.status,
        secondResult.stderr + secondResult.stdout,
      ).toBe(0);
      expect(firstResult.stdout + secondResult.stdout).toContain(
        "provisioned successfully",
      );
      expect(firstResult.stdout + secondResult.stdout).toMatch(
        /Another model download|already provisioned/,
      );
      for (const file of TIER_DOWNLOADS[TIER].files) {
        expect(existsSync(join(modelRoot, TIER, file)), file).toBe(true);
      }
      expect(existsSync(join(modelRoot, ".provisioning"))).toBe(false);
    },
  );
});
