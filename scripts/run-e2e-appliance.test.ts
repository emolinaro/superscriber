import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "run-e2e-appliance.sh");

describe("e2e appliance OIDC directory", () => {
  let testRoot: string | undefined;

  afterEach(() => {
    if (testRoot) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("refuses an override outside the repository .tmp before cleanup", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-oidc-dir-guard-"));
    const fakeBin = join(testRoot, "bin");
    const oidcDir = join(testRoot, "oidc");
    const markerPath = join(oidcDir, "marker");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(oidcDir, { recursive: true });
    writeFileSync(markerPath, "preserve");

    const pythonPath = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
    const fakePython = join(fakeBin, "python3");
    writeFileSync(
      fakePython,
      `#!/bin/sh\nif [ "\${1:-}" = "-" ]; then\n  exec '${pythonPath}' "$@"\nfi\nexit 0\n`,
    );
    chmodSync(fakePython, 0o755);

    const fakeDocker = join(fakeBin, "docker");
    writeFileSync(fakeDocker, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeDocker, 0o755);

    const result = spawnSync("bash", [SCRIPT_PATH, "start"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SUPERSCRIBER_E2E_OIDC_DIR: oidcDir,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OIDC config directory must be inside");
    expect(readFileSync(markerPath, "utf8")).toBe("preserve");
  });
});
