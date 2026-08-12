// local-deploy-bootstrap: script-level coverage for the local deployment
// bootstrap. Follows the repo convention for testing shell scripts from
// vitest (scripts/run-e2e-appliance.test.ts): real invocations against
// scratch roots under the os tmpdir (tests only - the product script itself
// refuses /tmp instance roots).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");
const BOOTSTRAP = join(REPO_ROOT, "scripts", "bootstrap-local.sh");

/** A port the OS reports as free right now (tests immediately bind nothing). */
function freePort(): string {
  const result = spawnSync(
    "node",
    [
      "-e",
      "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const port = result.stdout.trim();
  if (!/^\d+$/.test(port)) {
    throw new Error(`could not find a free port: ${result.stderr}`);
  }
  return port;
}
const RUN = join(REPO_ROOT, "scripts", "instance-run.sh");
const STOP = join(REPO_ROOT, "scripts", "instance-stop.sh");
const SCRIPTS = [BOOTSTRAP, RUN, STOP];

function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

describe("local deployment bootstrap scripts", () => {
  let testRoot: string | undefined;

  afterEach(() => {
    if (testRoot) {
      rmSync(testRoot, { recursive: true, force: true });
      testRoot = undefined;
    }
  });

  it("parses cleanly under bash -n", () => {
    for (const script of SCRIPTS) {
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
    }
  });

  it("is shellcheck-clean when shellcheck is available", () => {
    const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) {
      return; // host without shellcheck: covered in dev/CI environments
    }
    const result = spawnSync("shellcheck", SCRIPTS, { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("--help documents the instance root, port, and model tier flags", () => {
    const result = runScript(BOOTSTRAP, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--instance-root");
    expect(result.stdout).toContain("--port");
    expect(result.stdout).toContain("--model-tier");
  });

  it("fails loudly with an actionable message when node is missing", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const fakeBin = join(testRoot, "bin");
    mkdirSync(fakeBin, { recursive: true });
    // Only POSIX coreutils are reachable: node, npm, python3 all vanish
    // (they live outside /usr/bin on this host class).
    const result = runScript(BOOTSTRAP, ["--check-deps-only"], {
      PATH: `${fakeBin}:/usr/bin:/bin`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node.js is not installed");
    expect(result.stderr).toMatch(/Install Node/);
  });

  it("rejects an instance root under /tmp", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const result = runScript(
      BOOTSTRAP,
      ["--instance-root", join(testRoot, "nope"), "--port", freePort(), "--skip-model-download", "--skip-worker-deps"],
      // Hand the script a world where npm ci is satisfied instantly: stub npm.
      stubNpmEnv(testRoot),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("never the system temp dir");
  });

  it("instance-run refuses a foreign process on the instance port", async () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const instance = join(testRoot, "instance");
    mkdirSync(join(instance, "pids"), { recursive: true });

    // Occupy a real free port with a short-lived holder, then claim it in app.env.
    const holder: ChildProcess = spawn(
      "node",
      [
        "-e",
        "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setTimeout(()=>{},30000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const port = await new Promise<string>((resolvePromise, rejectPromise) => {
      let buffer = "";
      holder.stdout?.on("data", (chunk) => {
        buffer += String(chunk);
        if (buffer.trim().length > 0) {
          resolvePromise(buffer.trim());
        }
      });
      holder.on("error", rejectPromise);
      setTimeout(() => rejectPromise(new Error("port holder never bound")), 10_000);
    });
    expect(port).toMatch(/^\d+$/);
    writeFileSync(join(instance, "app.env"), `PORT=${port}\n`);

    try {
      const result = runScript(RUN, [instance]);
      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toContain("occupied by a foreign process");
    } finally {
      holder.kill("SIGTERM");
    }
  });

  it("instance-stop is a no-op when the instance never started", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const instance = join(testRoot, "instance");
    mkdirSync(instance, { recursive: true });
    const result = runScript(STOP, [instance]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not running");
  });

  it("bootstrap writes app.env without embedding secret values", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const instance = join(testRoot, "instance");
    const port = freePort();
    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root", instance,
        "--port", port,
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      // Stub npm/npx so ci, tsx, and the health probe are no-ops; the
      // stubbed `npm run build` fails, stopping bootstrap right after it has
      // written the instance files this test asserts on.
      {
        ...stubNpxEnv(testRoot),
        SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "1",
      },
    );
    // The stubbed build fails, so bootstrap stops before launch - but the
    // instance files it already wrote are the assertion target.
    expect(result.status).not.toBe(0);
    const envContent = readFileSync(join(instance, "app.env"), "utf8");
    expect(envContent).toContain("SUPERSCRIBER_AUTH_MODE=local");
    expect(envContent).toContain(`PORT=${port}`);
    expect(envContent).not.toContain("AUTH_SECRET=");
    const authSecret = readFileSync(join(instance, "secrets", "auth.secret"), "utf8");
    const engineSecret = readFileSync(join(instance, "secrets", "engine.secret"), "utf8");
    expect(authSecret.trim()).toMatch(/^[0-9a-f]{96}$/);
    expect(engineSecret.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(envContent).not.toContain(authSecret.trim());
    expect(envContent).not.toContain(engineSecret.trim());
    expect(existsSync(join(instance, "data"))).toBe(true);
  });
});

/** PATH with a stub npm that succeeds instantly (deps "already installed"). */
function stubNpmEnv(testRoot: string): Record<string, string> {
  const fakeBin = join(testRoot, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const npm = join(fakeBin, "npm");
  writeFileSync(npm, "#!/bin/sh\nexit 0\n");
  chmodSync(npm, 0o755);
  return { PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
}

/** PATH with stub npm + npx (skip tsx/db work) and a failing `npm run build`. */
function stubNpxEnv(testRoot: string) {
  const env = stubNpmEnv(testRoot);
  const fakeBin = join(testRoot, "bin");
  const npx = join(fakeBin, "npx");
  writeFileSync(npx, "#!/bin/sh\nexit 0\n");
  chmodSync(npx, 0o755);
  // npm ci must succeed but `npm run build` must fail so we stop before launch.
  writeFileSync(
    join(fakeBin, "npm"),
    '#!/bin/sh\nif [ "$1" = "run" ]; then exit 1; fi\nexit 0\n',
  );
  chmodSync(join(fakeBin, "npm"), 0o755);
  return env;
}
