// local-deploy-bootstrap: end-to-end coverage for the operator model-provisioning
// CLI, driven through the repo's fixture download seam
// (SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR) so no network is needed. Verifies
// the same pinned-artifact install path the in-app flow uses: complete file
// set staged, then revealed under <modelRoot>/<tier>/, plus offline-capable
// skip-on-second-run behavior.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
      writeFileSync(join(fixtureDir, file), `fixture-bytes-for-${file}`);
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
});
