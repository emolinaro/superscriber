// local-deploy-bootstrap: script-level coverage for the local deployment
// bootstrap. Follows the repo convention for testing shell scripts from
// vitest (scripts/run-e2e-appliance.test.ts): real invocations against
// isolated scratch roots, with temporary-root rejection exercised separately.

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
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

async function holdPort(): Promise<{ port: string; stop: () => Promise<void> }> {
  const holder: ChildProcess = spawn(
    "node",
    [
      "-e",
      "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port)});setInterval(()=>{},1000)",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const closed = new Promise<void>((resolvePromise) => {
    holder.once("close", () => resolvePromise());
  });

  try {
    const port = await new Promise<string>((resolvePromise, rejectPromise) => {
      let buffer = "";
      const cleanup = () => {
        clearTimeout(timeout);
        holder.stdout?.off("data", onData);
        holder.off("error", onError);
        holder.off("close", onClose);
      };
      const onData = (chunk: Buffer) => {
        buffer += String(chunk);
        if (buffer.trim().length === 0) return;
        cleanup();
        resolvePromise(buffer.trim());
      };
      const onError = (error: Error) => {
        cleanup();
        rejectPromise(error);
      };
      const onClose = () => {
        cleanup();
        rejectPromise(new Error("port holder exited before binding"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        rejectPromise(new Error("port holder never bound"));
      }, 10_000);
      holder.stdout?.on("data", onData);
      holder.once("error", onError);
      holder.once("close", onClose);
    });

    return {
      port,
      stop: async () => {
        if (holder.exitCode === null && holder.signalCode === null) {
          holder.kill("SIGTERM");
        }
        await closed;
      },
    };
  } catch (error) {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGTERM");
    }
    await closed;
    throw error;
  }
}
const RUN = join(REPO_ROOT, "scripts", "instance-run.sh");
const STOP = join(REPO_ROOT, "scripts", "instance-stop.sh");
const INSTANCE_PATHS = join(REPO_ROOT, "scripts", "instance-paths.sh");
const SCRIPTS = [BOOTSTRAP, RUN, STOP, INSTANCE_PATHS];
const REQUIRED_NODE_VERSION = "24.18.1";

function runScript(
  script: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return spawnSync("bash", [script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "1",
      ...env,
    },
    timeout: 60_000,
  });
}

function runScriptAsync(
  script: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const child = spawn("bash", [script, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "1",
      ...env,
    },
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
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolvePromise, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    },
  );
}

describe("local deployment bootstrap scripts", () => {
  let testRoot: string | undefined;
  const runningInstances = new Set<string>();

  afterEach(() => {
    for (const instance of runningInstances) {
      runScript(STOP, [instance]);
    }
    runningInstances.clear();
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

  it("prints a shell-quoted rerun command with the selected root and port", () => {
    const source = readFileSync(BOOTSTRAP, "utf8");
    expect(source).toContain(
      "printf -v bootstrap_command '%q --instance-root %q --port %q'",
    );
    expect(source).toContain(
      "Re-run bootstrap:   ${bootstrap_command} (idempotent)",
    );
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

  it("rejects a Node version newer than the Dockerfile pin", () => {
    testRoot = worktreeTestRoot();
    const result = runScript(
      BOOTSTRAP,
      ["--check-deps-only"],
      stubToolchainEnv(testRoot, { nodeVersion: "24.18.2" }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `requires exactly Node ${REQUIRED_NODE_VERSION}`,
    );
    expect(result.stderr).toContain("Dockerfile:4");
  });

  it("preflights Python venv and ensurepip capability", () => {
    testRoot = worktreeTestRoot();
    const env = stubToolchainEnv(testRoot, { brokenVenv: true });
    const result = runScript(BOOTSTRAP, ["--check-deps-only"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("python3-venv");
    expect(result.stderr).toContain("ensurepip");
  });

  it.each([
    ["not-a-port", "port must be a number"],
    ["80", "port 80 is outside 1024-65535"],
  ])(
    "rejects invalid port %s before creating instance state",
    (port, expectedError) => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, `instance-${port}`);

      const result = runScript(
        BOOTSTRAP,
        ["--instance-root", instance, "--port", port],
        stubToolchainEnv(testRoot),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
      expect(existsSync(instance)).toBe(false);
    },
  );

  it("rejects an instance root under /tmp", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root",
        join(testRoot, "nope"),
        "--port",
        freePort(),
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      // Hand the script a world where npm ci is satisfied instantly: stub npm.
      {
        ...stubToolchainEnv(testRoot),
        SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "0",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("never the system temp dir");
  });

  it("rejects the exact configured temp root before writing instance state", () => {
    testRoot = worktreeTestRoot();
    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root",
        testRoot,
        "--port",
        freePort(),
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      {
        ...stubToolchainEnv(testRoot),
        TMPDIR: testRoot,
        SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "0",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("never the system temp dir");
    expect(existsSync(join(testRoot, "app.env"))).toBe(false);
  });

  it("rejects the filesystem root before writing instance state", () => {
    testRoot = worktreeTestRoot();
    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root",
        "/",
        "--port",
        freePort(),
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      {
        ...stubToolchainEnv(testRoot),
        SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "0",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not the filesystem root");
  });

  it("rejects a durable-looking symlink into the configured temp root", () => {
    testRoot = worktreeTestRoot();
    const tempRoot = join(testRoot, "temporary-storage");
    const durableLink = join(testRoot, "durable-looking");
    mkdirSync(tempRoot);
    symlinkSync(tempRoot, durableLink);
    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root",
        join(durableLink, "instance"),
        "--port",
        freePort(),
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      {
        ...stubToolchainEnv(testRoot),
        TMPDIR: tempRoot,
        SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "0",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("never the system temp dir");
    expect(existsSync(join(tempRoot, "instance"))).toBe(false);
  });

  it("rejects direct start and stop under a temporary root before writing state", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const instance = join(testRoot, "instance");
    markInstanceRoot(instance);
    const env = {
      SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT: "0",
      TMPDIR: testRoot,
    };

    const start = runScript(RUN, [instance], env);
    const stop = runScript(STOP, [instance], env);

    expect(start.status).toBe(1);
    expect(stop.status).toBe(1);
    expect(start.stderr).toContain("never the system temp dir");
    expect(stop.stderr).toContain("never the system temp dir");
    expect(existsSync(join(instance, "logs"))).toBe(false);
    expect(existsSync(join(instance, "pids"))).toBe(false);
  });

  it("refuses a non-empty unowned root without mutating it", () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "not-an-instance");
    mkdirSync(instance, { recursive: true });
    const existing = join(instance, "keep.txt");
    writeFileSync(existing, "keep");
    chmodSync(existing, 0o644);

    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root",
        instance,
        "--port",
        freePort(),
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      stubToolchainEnv(testRoot),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-empty");
    expect(result.stderr).toContain("ownership marker");
    expect(readFileSync(existing, "utf8")).toBe("keep");
    expect(statSync(existing).mode & 0o777).toBe(0o644);
    expect(existsSync(join(instance, ".superscriber-instance"))).toBe(false);
  });

  it("rejects managed child symlinks before writing through them", () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    const outsideData = join(testRoot, "outside-data");
    markInstanceRoot(instance);
    mkdirSync(outsideData);
    symlinkSync(outsideData, join(instance, "data"));

    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root",
        instance,
        "--port",
        freePort(),
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      stubNpxEnv(testRoot),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("managed instance path must not be a symlink");
    expect(existsSync(join(outsideData, "media"))).toBe(false);
    expect(existsSync(join(instance, "app.env"))).toBe(false);
  });

  it.each([
    ["database", join("data", "superscriber.db")],
    ["database wal", join("data", "superscriber.db-wal")],
    ["auth secret", join("secrets", "auth.secret")],
    ["app log", join("logs", "app.log")],
    ["role identity", join("pids", "worker.identity")],
    ["model tier", join("model-cache", "small")],
    ["quiesce recovery record", "quiesce.pending"],
  ])("rejects a symlinked managed %s leaf", (_label, relative) => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    const outside = join(testRoot, "outside");
    markInstanceRoot(instance);
    mkdirSync(resolve(instance, relative, ".."), { recursive: true });
    if (relative === join("model-cache", "small")) {
      mkdirSync(outside);
      symlinkSync(outside, join(instance, relative));
    } else {
      writeFileSync(outside, "outside");
      symlinkSync(outside, join(instance, relative));
    }

    const result = runScript(
      BOOTSTRAP,
      [
        "--instance-root",
        instance,
        "--port",
        freePort(),
        "--skip-model-download",
        "--skip-worker-deps",
      ],
      stubNpxEnv(testRoot),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("managed instance path must not be a symlink");
    if (relative !== join("model-cache", "small")) {
      expect(readFileSync(outside, "utf8")).toBe("outside");
    }
  });

  it(
    "accepts the interpreter symlinks created by a standard Python venv",
    { timeout: 15_000 },
    () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      markInstanceRoot(instance);
      const created = spawnSync(
        "python3",
        ["-m", "venv", join(instance, "venv")],
        { encoding: "utf8" },
      );
      expect(created.status, created.stderr).toBe(0);

      const result = spawnSync(
        "bash",
        [
          "-c",
          '. "$1"; reject_managed_instance_symlinks "$2"',
          "bash",
          INSTANCE_PATHS,
          instance,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("recovers an aged malformed reclaim owner", () => {
    testRoot = worktreeTestRoot();
    const lock = join(testRoot, "resource.lock");
    const reclaim = `${lock}.reclaim`;
    mkdirSync(reclaim);
    writeFileSync(join(reclaim, "identity"), "incomplete");
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(reclaim, staleTime, staleTime);

    const result = spawnSync(
      "bash",
      [
        "-c",
        '. "$1"; claim="$(acquire_reclaim_slot "$2")"; reclaim_slot_is_owned "$2" "$claim"; release_reclaim_slot "$2" "$claim"',
        "bash",
        INSTANCE_PATHS,
        lock,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(reclaim)).toBe(false);
  });

  it("instance-run refuses a foreign process on the instance port", async () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const instance = join(testRoot, "instance");
    mkdirSync(join(instance, "pids"), { recursive: true });
    markInstanceRoot(instance);

    const holder = await holdPort();
    expect(holder.port).toMatch(/^\d+$/);
    writeFileSync(join(instance, "app.env"), `PORT=${holder.port}\n`);

    try {
      const result = runScript(RUN, [instance], withoutLsofPath(testRoot));
      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).toContain(
        "occupied by a foreign process",
      );
    } finally {
      await holder.stop();
    }
  });

  it("instance-stop never signals a recycled foreign pid", async () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    mkdirSync(join(instance, "pids"), { recursive: true });
    markInstanceRoot(instance);
    const holder = spawn("node", ["-e", "setTimeout(()=>{},30000)"], {
      stdio: "ignore",
    });
    await waitForCondition(() => holder.pid !== undefined);
    writeFileSync(join(instance, "pids", "supervisor.pid"), `${holder.pid}\n`);

    const result = runScript(STOP, [instance]);
    expect(result.status).toBe(0);
    expect(holder.pid && process.kill(holder.pid, 0)).toBe(true);
    holder.kill("SIGTERM");
  });

  it(
    "atomically admits one supervisor across concurrent starts",
    { timeout: 20_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      const appServer = join(testRoot, "server.js");
      const workerPython = join(testRoot, "worker-python");
      writeFileSync(appServer, "setTimeout(()=>{},30000)\n");
      writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(workerPython, 0o700);
      prepareRunnableInstance(instance, port, appServer, workerPython);
      runningInstances.add(instance);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => runScriptAsync(RUN, [instance])),
      );
      for (const result of results) {
        expect(result.status, result.stderr + result.stdout).toBe(0);
      }
      expect(
        results.filter((result) => result.stdout.includes("started supervisor"))
          .length,
      ).toBe(1);
      expect(
        results.filter((result) => result.stdout.includes("already running"))
          .length,
      ).toBe(5);
      expect(runScript(RUN, [instance, "--status"]).status).toBe(0);
    },
  );

  it("instance-stop is a no-op when the instance never started", () => {
    testRoot = mkdtempSync(join(tmpdir(), "superscriber-bootstrap-test-"));
    const instance = join(testRoot, "instance");
    mkdirSync(instance, { recursive: true });
    markInstanceRoot(instance);
    const result = runScript(STOP, [instance]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not running");
  });

  it("refuses a direct start while bootstrap maintenance owns the instance", () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    const port = freePort();
    const appServer = join(testRoot, "server.js");
    const workerPython = join(testRoot, "worker-python");
    writeFileSync(appServer, "setTimeout(()=>{},30000)\n");
    writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(workerPython, 0o700);
    prepareRunnableInstance(instance, port, appServer, workerPython);
    mkdirSync(join(instance, "pids", "maintenance.lock"));
    writeFileSync(
      join(instance, "pids", "maintenance.lock", "identity"),
      `2147483647 ${"a".repeat(48)} 1-1\n`,
    );

    const result = runScript(RUN, [instance]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("maintenance lock");
    expect(runScript(RUN, [instance, "--status"]).status).toBe(1);
  });

  it("serializes parallel bootstraps through launch preparation", { timeout: 30_000 }, async () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    const modelDir = join(instance, "model-cache", "medium");
    markInstanceRoot(instance);
    mkdirSync(modelDir, { recursive: true });
    writeModelTier(modelDir, "txt");
    prepareWorkingVenv(instance);
    const env = stubNpxEnv(testRoot);
    writeFileSync(
      join(testRoot, "bin", "npm"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.19.0; exit 0; fi\nif [ "$1" = "ci" ]; then sleep 15; exit 0; fi\nif [ "$1" = "run" ]; then exit 1; fi\nexit 0\n',
    );
    chmodSync(join(testRoot, "bin", "npm"), 0o700);
    const args = [
      "--instance-root",
      instance,
      "--port",
      freePort(),
      "--model-tier",
      "medium",
      "--skip-model-download",
      "--skip-worker-deps",
    ];
    const secondArgs = [...args];
    secondArgs[3] = freePort();

    const first = runScriptAsync(BOOTSTRAP, args, env);
    await waitForCondition(() =>
      existsSync(join(instance, "pids", "maintenance.lock", "identity")),
    );
    const second = runScript(BOOTSTRAP, secondArgs, env);

    expect(second.status).toBe(1);
    expect(second.stderr).toContain("another bootstrap is maintaining");
    expect((await first).status).not.toBe(0);
  });

  it("clears exited role identity before restart backoff", async () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    const port = freePort();
    const appServer = join(testRoot, "server.js");
    const workerPython = join(testRoot, "worker-python");
    writeFileSync(appServer, "process.exit(1)\n");
    writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(workerPython, 0o700);
    prepareRunnableInstance(instance, port, appServer, workerPython);
    runningInstances.add(instance);

    const start = runScript(RUN, [instance]);
    expect(start.status, start.stderr + start.stdout).toBe(0);
    await waitForCondition(() => {
      const log = join(instance, "logs", "supervisor.log");
      return (
        existsSync(log) &&
        readFileSync(log, "utf8").includes("app exited status=1")
      );
    });

    expect(existsSync(join(instance, "pids", "app.identity"))).toBe(false);
    expect(existsSync(join(instance, "pids", "app.pid"))).toBe(false);
    expect(runScript(RUN, [instance, "--app-running"]).status).toBe(1);
  });

  it(
    "stops the supervisor promptly during role restart backoff",
    { timeout: 25_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const appServer = join(testRoot, "server.js");
      const workerPython = join(testRoot, "worker-python");
      writeFileSync(appServer, "process.exit(1)\n");
      writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(workerPython, 0o700);
      prepareRunnableInstance(
        instance,
        freePort(),
        appServer,
        workerPython,
      );
      runningInstances.add(instance);

      const start = runScript(RUN, [instance]);
      expect(start.status, start.stderr + start.stdout).toBe(0);
      await waitForCondition(() => {
        const log = join(instance, "logs", "supervisor.log");
        return (
          existsSync(log) &&
          readFileSync(log, "utf8").includes("app exited status=1") &&
          readFileSync(log, "utf8").includes("restart 2 in 15s")
        );
      }, 12_000);

      const stopStarted = Date.now();
      const stop = runScript(STOP, [instance]);
      const stopElapsed = Date.now() - stopStarted;

      expect(stop.status, stop.stderr + stop.stdout).toBe(0);
      expect(stopElapsed).toBeLessThan(5_000);
      expect(runScript(RUN, [instance, "--status"]).status).toBe(1);
    },
  );

  it(
    "requires a working worker venv when dependency installation is skipped",
    { timeout: 20_000 },
    () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      markInstanceRoot(instance);
      const result = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          freePort(),
          "--model-tier",
          "tiny",
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        stubNpxEnv(testRoot),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("worker venv is missing");
    },
  );

  it(
    "sweeps interrupted build generations while holding lifecycle locks",
    { timeout: 20_000 },
    () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const staleInstanceBuild = join(
        instance,
        "build",
        ".staging-interrupted",
      );
      const staleRepositoryBuild = join(
        REPO_ROOT,
        ".superscriber-build-output",
        "interrupted",
      );
      const incompleteBundle = join(
        instance,
        "build",
        `${"f".repeat(40)}-${"e".repeat(48)}`,
      );
      const orphanBundle = join(
        instance,
        "build",
        `${"d".repeat(40)}-${"c".repeat(48)}`,
      );
      const outside = join(testRoot, "outside");
      const observed = join(testRoot, "stale-builds-cleared");
      markInstanceRoot(instance);
      mkdirSync(staleInstanceBuild, { recursive: true });
      mkdirSync(staleRepositoryBuild, { recursive: true });
      mkdirSync(incompleteBundle, { recursive: true });
      mkdirSync(orphanBundle, { recursive: true });
      writeFileSync(join(staleInstanceBuild, "partial"), "partial");
      writeFileSync(join(staleRepositoryBuild, "partial"), "partial");
      writeFileSync(
        join(incompleteBundle, ".incomplete"),
        "superscriber-build-generation-v1\n",
      );
      writeFileSync(join(orphanBundle, "server.js"), "orphan");
      writeFileSync(outside, "outside");
      symlinkSync(outside, join(staleInstanceBuild, "outside-link"));
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareWorkingVenv(instance);
      const env = stubNpxEnv(testRoot);
      writeFileSync(
        join(testRoot, "bin", "npm"),
        `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo 11.19.0; exit 0; fi
if [ "\${1:-}" = "ci" ]; then
  [ ! -e "$STALE_INSTANCE_BUILD" ] || exit 93
  [ ! -e "$STALE_REPOSITORY_BUILD" ] || exit 94
  [ ! -e "$INCOMPLETE_BUNDLE" ] || exit 97
  [ ! -e "$ORPHAN_BUNDLE" ] || exit 98
  [ -d "$MAINTENANCE_LOCK" ] || exit 95
  [ -d "$REPOSITORY_LOCK" ] || exit 96
  : > "$SWEEP_OBSERVED"
  exit 0
fi
if [ "\${1:-}" = "run" ]; then exit 1; fi
exit 0
`,
      );
      chmodSync(join(testRoot, "bin", "npm"), 0o700);

      try {
        const result = runScript(
          BOOTSTRAP,
          [
            "--instance-root",
            instance,
            "--port",
            freePort(),
            "--model-tier",
            "medium",
            "--skip-model-download",
            "--skip-worker-deps",
          ],
          {
            ...env,
            STALE_INSTANCE_BUILD: staleInstanceBuild,
            STALE_REPOSITORY_BUILD: staleRepositoryBuild,
            INCOMPLETE_BUNDLE: incompleteBundle,
            ORPHAN_BUNDLE: orphanBundle,
            SWEEP_OBSERVED: observed,
            MAINTENANCE_LOCK: join(instance, "pids", "maintenance.lock"),
            REPOSITORY_LOCK: join(
              REPO_ROOT,
              ".superscriber-bootstrap-repository.lock",
            ),
          },
        );

        expect(result.status).not.toBe(0);
        expect(existsSync(observed)).toBe(true);
        expect(existsSync(staleInstanceBuild)).toBe(false);
        expect(existsSync(staleRepositoryBuild)).toBe(false);
        expect(existsSync(incompleteBundle)).toBe(false);
        expect(existsSync(orphanBundle)).toBe(false);
        expect(readFileSync(outside, "utf8")).toBe("outside");
      } finally {
        rmSync(join(REPO_ROOT, ".superscriber-build-output"), {
          recursive: true,
          force: true,
        });
      }
    },
  );

  it(
    "bootstrap writes app.env without embedding secret values",
    { timeout: 20_000 },
    () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance with spaces");
      markInstanceRoot(instance);
      mkdirSync(join(instance, "data"), { recursive: true });
      mkdirSync(join(instance, "logs"), { recursive: true });
      writeFileSync(join(instance, "data", "existing.db"), "db");
      writeFileSync(join(instance, "logs", "existing.log"), "log");
      chmodSync(join(instance, "data"), 0o755);
      chmodSync(join(instance, "logs"), 0o755);
      chmodSync(join(instance, "data", "existing.db"), 0o644);
      chmodSync(join(instance, "logs", "existing.log"), 0o644);
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareWorkingVenv(instance);
      const port = freePort();
      const result = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          port,
          "--model-tier",
          "medium",
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        // Stub npm/npx so ci, tsx, and the health probe are no-ops; the
        // stubbed `npm run build` fails, stopping bootstrap right after it has
        // written the instance files this test asserts on.
        {
          ...stubNpxEnv(testRoot),
        },
      );
      // The stubbed build fails, so bootstrap stops before launch - but the
      // instance directories and secrets it already wrote are the assertion target.
      expect(result.status).not.toBe(0);
      expect(existsSync(join(instance, "app.env"))).toBe(false);
      const authSecret = readFileSync(
        join(instance, "secrets", "auth.secret"),
        "utf8",
      );
      const engineSecret = readFileSync(
        join(instance, "secrets", "engine.secret"),
        "utf8",
      );
      expect(authSecret.trim()).toMatch(/^[0-9a-f]{96}$/);
      expect(engineSecret.trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(instance, "data"))).toBe(true);
      expect(statSync(instance).mode & 0o777).toBe(0o700);
      expect(statSync(join(instance, "data")).mode & 0o777).toBe(0o700);
      expect(statSync(join(instance, "logs")).mode & 0o777).toBe(0o700);
      expect(statSync(join(instance, "data", "existing.db")).mode & 0o777).toBe(
        0o600,
      );
      expect(
        statSync(join(instance, "logs", "existing.log")).mode & 0o777,
      ).toBe(0o600);
    },
  );

  it(
    "preserves the previously configured tier on an offline rerun",
    { timeout: 20_000 },
    () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      markInstanceRoot(instance);
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareWorkingVenv(instance);
      writeFileSync(
        join(instance, "app.env"),
        "SUPERSCRIBER_TRANSCRIBE_MODEL=medium\n",
      );
      const result = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          freePort(),
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        stubNpxEnv(testRoot),
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(instance, "app.env"), "utf8")).toBe(
        "SUPERSCRIBER_TRANSCRIBE_MODEL=medium\n",
      );
    },
  );

  it("revalidates maintenance ownership in the supervisor child", () => {
    const source = readFileSync(RUN, "utf8");
    const superviseCase = source.indexOf('[[ "${SUPERVISOR_TOKEN}" =~');
    const revalidation = source.indexOf("valid_maintenance_authorization ||", superviseCase);
    const identityPublish = source.indexOf('mv "${identity_tmp}" "${IDENTITY_FILE}"');
    expect(superviseCase).toBeGreaterThan(-1);
    expect(revalidation).toBeGreaterThan(superviseCase);
    expect(identityPublish).toBeGreaterThan(revalidation);
  });

  it(
    "restarts a role after identity publication fails",
    { timeout: 20_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const appServer = join(testRoot, "server.js");
      const workerPython = join(testRoot, "worker-python");
      writeFileSync(appServer, "setTimeout(()=>{},30000)\n");
      writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(workerPython, 0o700);
      prepareRunnableInstance(instance, freePort(), appServer, workerPython, [
        "SUPERSCRIBER_TEST_FAIL_ROLE_IDENTITY_ONCE=app",
      ]);
      runningInstances.add(instance);

      const start = runScript(RUN, [instance]);
      expect(start.status, start.stderr + start.stdout).toBe(0);
      await waitForCondition(
        () => runScript(RUN, [instance, "--app-running"]).status === 0,
        15_000,
      );
      const log = readFileSync(
        join(instance, "logs", "supervisor.log"),
        "utf8",
      );
      expect(log).toContain(
        "app identity publication failed; child terminated",
      );
      expect(log.match(/app starting:/g)?.length).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    "terminates an app signaled during role identity publication",
    { timeout: 20_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const appServer = join(testRoot, "server.js");
      const appPidFile = join(testRoot, "app.pid");
      const workerPython = join(testRoot, "worker-python");
      writeFileSync(
        appServer,
        `require("node:fs").writeFileSync(${JSON.stringify(appPidFile)},String(process.pid));setInterval(()=>{},30000)\n`,
      );
      writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(workerPython, 0o700);
      prepareRunnableInstance(instance, freePort(), appServer, workerPython, [
        "SUPERSCRIBER_TEST_PAUSE_ROLE_IDENTITY=app",
      ]);
      runningInstances.add(instance);

      const start = runScript(RUN, [instance]);
      expect(start.status, start.stderr + start.stdout).toBe(0);
      await waitForCondition(() => existsSync(appPidFile));
      const appPid = Number(readFileSync(appPidFile, "utf8"));
      expect(processIsRunning(appPid)).toBe(true);

      const stop = runScript(STOP, [instance]);
      expect(stop.status, stop.stderr + stop.stdout).toBe(0);
      await waitForCondition(() => !processIsRunning(appPid));
    },
  );

  it("launches only a hash-verified active bundle", () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    const appServer = join(testRoot, "server.js");
    const workerPython = join(testRoot, "worker-python");
    writeFileSync(appServer, "setTimeout(()=>{},30000)\n");
    writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(workerPython, 0o700);
    prepareRunnableInstance(instance, freePort(), appServer, workerPython);
    const bundleId = activationIdFrom(instance);
    writeFileSync(join(instance, "build", bundleId, "server.js"), "tampered\n");

    const result = runScript(RUN, [instance]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("valid immutable instance bundle");
    expect(runScript(RUN, [instance, "--status"]).status).toBe(1);
  });

  it("ignores app entrypoint overrides outside explicit test mode", async () => {
    testRoot = worktreeTestRoot();
    const instance = join(testRoot, "instance");
    const appServer = join(testRoot, "external-server.js");
    const workerPython = join(testRoot, "worker-python");
    const selectedServer = join(testRoot, "selected-server");
    writeFileSync(
      appServer,
      `require("node:fs").writeFileSync(${JSON.stringify(selectedServer)}, "override");setTimeout(()=>{},30000)\n`,
    );
    writeFileSync(workerPython, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(workerPython, 0o700);
    prepareRunnableInstance(
      instance,
      freePort(),
      appServer,
      workerPython,
      [
        `SUPERSCRIBER_APP_SERVER=${shellQuote(appServer)}`,
        "SUPERSCRIBER_INSTANCE_TEST_MODE=0",
      ],
      `require("node:fs").writeFileSync(${JSON.stringify(selectedServer)}, "bundle");setTimeout(()=>{},30000)\n`,
    );
    runningInstances.add(instance);

    const start = runScript(RUN, [instance]);
    expect(start.status, start.stderr + start.stdout).toBe(0);
    await waitForCondition(() => existsSync(selectedServer));
    expect(readFileSync(selectedServer, "utf8")).toBe("bundle");
  });

  it(
    "activates one record while retaining only active and rollback bundles",
    { timeout: 30_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      const oldServer = join(testRoot, "old-server.js");
      const oldWorker = join(testRoot, "old-worker");
      writeFileSync(oldServer, "setTimeout(()=>{},30000)\n");
      writeFileSync(oldWorker, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(oldWorker, 0o700);
      prepareRunnableInstance(instance, port, oldServer, oldWorker);
      const oldId = activationIdFrom(instance);
      runningInstances.add(instance);
      const oldStart = runScript(RUN, [instance]);
      expect(oldStart.status, oldStart.stderr + oldStart.stdout).toBe(0);
      await waitForCondition(
        () => runScript(RUN, [instance, "--status"]).status === 0,
      );
      for (const token of ["c", "d"]) {
        mkdirSync(
          join(instance, "build", `${"e".repeat(40)}-${token.repeat(48)}`),
        );
      }
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareBootstrapVenv(instance, true);

      const result = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          port,
          "--model-tier",
          "medium",
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        stubSuccessfulBuildEnv(testRoot, healthyServerSource()),
      );

      expect(result.status, result.stderr + result.stdout).toBe(0);
      const activeId = activationIdFrom(instance);
      const activeBundle = join(instance, "build", activeId);
      expect(activeId).not.toBe(oldId);
      expect(readFileSync(join(instance, "app.env"), "utf8")).toContain(
        `SUPERSCRIBER_WORKER_VENV=${activeBundle}/venv`,
      );
      expect(existsSync(join(activeBundle, "venv", "bin", "python3"))).toBe(
        true,
      );
      expect(
        readFileSync(join(activeBundle, "venv", "bin", "fixture-tool"), "utf8"),
      ).toContain(`#!${activeBundle}/venv/bin/python3`);
      expect(readFileSync(join(instance, "rollback.env"), "utf8")).toContain(
        `SUPERSCRIBER_ACTIVATION_ID=${oldId}`,
      );
      expect(readFileSync(join(instance, "rollback.env"), "utf8")).toContain(
        `SUPERSCRIBER_WORKER_VENV=${shellQuote(join(instance, "build", oldId, "venv"))}`,
      );
      expect(existsSync(join(instance, "build", oldId, "venv"))).toBe(true);
      expect(existsSync(join(instance, "active-bundle"))).toBe(false);
      const generations = readdirSync(join(instance, "build")).filter((name) =>
        /^[0-9a-f]{40}-[0-9a-f]{48}$/.test(name),
      );
      expect(generations.sort()).toEqual([activeId, oldId].sort());
    },
  );

  it(
    "restores and restarts the previous activation when a candidate fails",
    { timeout: 60_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      let candidatePort = freePort();
      while (candidatePort === port) candidatePort = freePort();
      const oldServer = join(testRoot, "old-server.js");
      const oldWorker = join(testRoot, "old-worker");
      writeFileSync(oldServer, healthyServerSource());
      writeFileSync(oldWorker, readyWorkerScript());
      chmodSync(oldWorker, 0o700);
      prepareRunnableInstance(instance, port, oldServer, oldWorker);
      const previousActivation = readFileSync(join(instance, "app.env"), "utf8");
      const previousId = activationIdFrom(instance);
      expect(previousActivation).toContain(
        join(instance, "build", previousId, "venv"),
      );
      runningInstances.add(instance);
      const oldStart = runScript(RUN, [instance]);
      expect(oldStart.status, oldStart.stderr + oldStart.stdout).toBe(0);
      await waitForCondition(
        () => runScript(RUN, [instance, "--status"]).status === 0,
      );
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareActiveBundleVenv(instance, false);

      const result = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          candidatePort,
          "--model-tier",
          "medium",
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        stubSuccessfulBuildEnv(testRoot, healthyServerSource()),
      );

      expect(result.status).toBe(1);
      expect(readFileSync(join(instance, "app.env"), "utf8")).toBe(
        previousActivation,
      );
      expect(existsSync(join(instance, "activation.pending"))).toBe(false);
      await waitForCondition(
        () => runScript(RUN, [instance, "--app-running"]).status === 0,
        15_000,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--worker-ready"]).status === 0,
        15_000,
      );
    },
  );

  it(
    "keeps rollback pending until the previous app and worker are ready",
    { timeout: 75_000 },
    () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      const oldServer = join(testRoot, "old-server.js");
      const oldWorker = join(testRoot, "old-worker");
      writeFileSync(oldServer, healthyServerSource());
      writeFileSync(
        oldWorker,
        "#!/bin/sh\necho '[worker] startup failed: previous fixture' >&2\nexit 1\n",
      );
      chmodSync(oldWorker, 0o700);
      prepareRunnableInstance(instance, port, oldServer, oldWorker);
      const previousActivation = readFileSync(join(instance, "app.env"), "utf8");
      runningInstances.add(instance);
      const oldStart = runScript(RUN, [instance]);
      expect(oldStart.status, oldStart.stderr + oldStart.stdout).toBe(0);
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareActiveBundleVenv(instance, false);

      const result = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          port,
          "--model-tier",
          "medium",
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        stubSuccessfulBuildEnv(testRoot, healthyServerSource()),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "restoring the previous activation also failed",
      );
      expect(readFileSync(join(instance, "app.env"), "utf8")).toBe(
        previousActivation,
      );
      expect(existsSync(join(instance, "activation.pending"))).toBe(true);
    },
  );

  it(
    "recovers a persisted interrupted activation before the next build",
    { timeout: 60_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      const oldServer = join(testRoot, "old-server.js");
      const oldWorker = join(testRoot, "old-worker");
      writeFileSync(oldServer, healthyServerSource());
      writeFileSync(oldWorker, readyWorkerScript());
      chmodSync(oldWorker, 0o700);
      prepareRunnableInstance(instance, port, oldServer, oldWorker);
      const previousEnv = readFileSync(join(instance, "app.env"), "utf8");
      const previousId = activationIdFrom(instance);
      const candidateId = `${"c".repeat(40)}-${"d".repeat(48)}`;
      const previousBundle = join(instance, "build", previousId);
      const candidateBundle = join(instance, "build", candidateId);
      cpSync(previousBundle, candidateBundle, { recursive: true });
      const candidateEnv = previousEnv
        .replace(previousId, candidateId)
        .replaceAll(previousBundle, candidateBundle);
      writeFileSync(join(instance, "activation.previous"), previousEnv);
      writeFileSync(join(instance, "app.env"), candidateEnv);
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareBootstrapVenv(instance, true);
      runningInstances.add(instance);
      const candidateStart = runScript(RUN, [instance]);
      expect(
        candidateStart.status,
        candidateStart.stderr + candidateStart.stdout,
      ).toBe(0);
      await waitForCondition(
        () => runScript(RUN, [instance, "--status"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--app-running"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--worker-ready"]).status === 0,
      );
      writeFileSync(
        join(instance, "activation.pending"),
        [
          "FORMAT=superscriber-activation-v1",
          `CANDIDATE=${candidateId}`,
          `PREVIOUS=${previousId}`,
          "PREVIOUS_WAS_RUNNING=1",
          "",
        ].join("\n"),
      );

      const result = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          port,
          "--model-tier",
          "medium",
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        stubNpxEnv(testRoot),
      );

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(instance, "app.env"), "utf8")).toBe(previousEnv);
      expect(existsSync(join(instance, "activation.pending"))).toBe(false);
      expect(existsSync(join(instance, "activation.previous"))).toBe(false);
      expect(existsSync(candidateBundle)).toBe(false);
      await waitForCondition(
        () => runScript(RUN, [instance, "--status"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--app-running"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--worker-ready"]).status === 0,
      );
    },
  );

  it(
    "reports a worker startup failure instead of app-only readiness",
    { timeout: 20_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      const appServer = join(testRoot, "server.js");
      const workerPython = join(testRoot, "worker-python");
      writeFileSync(
        appServer,
        "require('node:http').createServer((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end('{\"ok\":true}')}).listen(Number(process.env.PORT),'127.0.0.1')\n",
      );
      writeFileSync(
        workerPython,
        "#!/bin/sh\necho '[worker] startup failed: missing model' >&2\nexit 1\n",
      );
      chmodSync(workerPython, 0o700);
      prepareRunnableInstance(instance, port, appServer, workerPython);
      runningInstances.add(instance);

      const start = runScript(RUN, [instance]);
      expect(start.status, start.stderr + start.stdout).toBe(0);
      await waitForCondition(() => {
        const result = runScript(RUN, [instance, "--worker-ready"]);
        return result.status === 2;
      });
      const readiness = runScript(RUN, [instance, "--worker-ready"]);
      expect(readiness.status).toBe(2);
    },
  );

  it(
    "restarts pre-quiescence recovery before rejecting an occupied candidate port",
    { timeout: 60_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      const appServer = join(testRoot, "server.js");
      const workerPython = join(testRoot, "worker-python");
      writeFileSync(appServer, healthyServerSource());
      writeFileSync(workerPython, readyWorkerScript());
      chmodSync(workerPython, 0o700);
      prepareRunnableInstance(instance, port, appServer, workerPython);
      const activationId = activationIdFrom(instance);
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      runningInstances.add(instance);
      const start = runScript(RUN, [instance]);
      expect(start.status, start.stderr + start.stdout).toBe(0);
      await waitForCondition(
        () => runScript(RUN, [instance, "--worker-ready"]).status === 0,
      );
      const previousSupervisor = readFileSync(
        join(instance, "pids", "supervisor.lock", "identity"),
        "utf8",
      );
      writeFileSync(
        join(instance, "quiesce.pending"),
        [
          "FORMAT=superscriber-quiesce-v1",
          `ACTIVATION=${activationId}`,
          "WAS_RUNNING=1",
          "",
        ].join("\n"),
      );
      const holder = await holdPort();

      try {
        const bootstrap = runScript(
          BOOTSTRAP,
          [
            "--instance-root",
            instance,
            "--port",
            holder.port,
            "--model-tier",
            "medium",
            "--skip-model-download",
            "--skip-worker-deps",
          ],
          stubNpxEnv(testRoot),
        );

        expect(bootstrap.status).toBe(1);
        expect(bootstrap.stderr).toContain("occupied by a foreign process");
        expect(existsSync(join(instance, "quiesce.pending"))).toBe(false);
        await waitForCondition(
          () => runScript(RUN, [instance, "--app-running"]).status === 0,
        );
        await waitForCondition(
          () => runScript(RUN, [instance, "--worker-ready"]).status === 0,
        );
        expect(
          readFileSync(
            join(instance, "pids", "supervisor.lock", "identity"),
            "utf8",
          ),
        ).not.toBe(previousSupervisor);
      } finally {
        await holder.stop();
      }
    },
  );

  it(
    "restarts a verified live instance when preparation fails before activation",
    { timeout: 40_000 },
    async () => {
      testRoot = worktreeTestRoot();
      const instance = join(testRoot, "instance");
      const port = freePort();
      const appServer = join(testRoot, "server.js");
      const workerPython = join(testRoot, "worker-python");
      writeFileSync(appServer, healthyServerSource());
      writeFileSync(workerPython, readyWorkerScript());
      chmodSync(workerPython, 0o700);
      prepareRunnableInstance(instance, port, appServer, workerPython);
      const modelDir = join(instance, "model-cache", "medium");
      mkdirSync(modelDir, { recursive: true });
      writeModelTier(modelDir, "txt");
      prepareWorkingVenv(instance);
      runningInstances.add(instance);
      const start = runScript(RUN, [instance]);
      expect(start.status, start.stderr + start.stdout).toBe(0);
      await waitForCondition(
        () => runScript(RUN, [instance, "--status"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--app-running"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--worker-ready"]).status === 0,
      );

      const bootstrap = runScript(
        BOOTSTRAP,
        [
          "--instance-root",
          instance,
          "--port",
          port,
          "--model-tier",
          "medium",
          "--skip-model-download",
          "--skip-worker-deps",
        ],
        stubNpxEnv(testRoot),
      );
      expect(bootstrap.status).not.toBe(0);
      await waitForCondition(
        () => runScript(RUN, [instance, "--status"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--app-running"]).status === 0,
      );
      await waitForCondition(
        () => runScript(RUN, [instance, "--worker-ready"]).status === 0,
      );
    },
  );
});

/** PATH with stub npm + npx (skip tsx/db work) and a failing `npm run build`. */
function stubNpxEnv(testRoot: string) {
  const env = stubToolchainEnv(testRoot);
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

function stubSuccessfulBuildEnv(testRoot: string, serverSource: string) {
  const env = stubToolchainEnv(testRoot);
  const fakeBin = join(testRoot, "bin");
  const serverFixture = join(testRoot, "candidate-server.js");
  writeFileSync(serverFixture, serverSource);
  writeFileSync(
    join(fakeBin, "npx"),
    '#!/bin/sh\n[ -d "$PWD/.superscriber-bootstrap-repository.lock" ] || exit 92\nexit 0\n',
  );
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo 11.19.0; exit 0; fi
[ -d "$PWD/.superscriber-bootstrap-repository.lock" ] || exit 91
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build" ]; then
  output="$PWD/$SUPERSCRIBER_NEXT_DIST_DIR"
  mkdir -p "$output/standalone" "$output/static"
  cp ${shellQuote(serverFixture)} "$output/standalone/server.js"
fi
exit 0
`,
  );
  chmodSync(join(fakeBin, "npx"), 0o700);
  chmodSync(join(fakeBin, "npm"), 0o700);
  return env;
}

function healthyServerSource() {
  return (
    "require('node:http').createServer((_q,r)=>{" +
    "r.writeHead(200,{'content-type':'application/json'});" +
    "r.end('{\"ok\":true}')}).listen(Number(process.env.PORT),'127.0.0.1')\n"
  );
}

function processIsRunning(pid: number) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
  });
  return result.status === 0 && !result.stdout.includes("Z");
}

function worktreeTestRoot() {
  return mkdtempSync(join(REPO_ROOT, ".bootstrap-test-"));
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stubToolchainEnv(
  testRoot: string,
  options: { nodeVersion?: string; brokenVenv?: boolean } = {},
): Record<string, string> {
  const fakeBin = join(testRoot, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const node = join(fakeBin, "node");
  const npm = join(fakeBin, "npm");
  const python = join(fakeBin, "python3");
  writeFileSync(
    node,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${options.nodeVersion ?? REQUIRED_NODE_VERSION}; exit 0; fi\nexec ${shellQuote(process.execPath)} "$@"\n`,
  );
  writeFileSync(
    npm,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.19.0; exit 0; fi\nif [ "$1" = "run" ]; then exit 1; fi\nexit 0\n',
  );
  if (options.brokenVenv) {
    writeFileSync(
      python,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'Python 3.13.0'; exit 0; fi\nif [ "$1" = "-c" ]; then echo '3.13'; exit 0; fi\nif [ "$1" = "-m" ] && [ "$2" = "venv" ]; then exit 1; fi\nexec ${shellQuote(process.env.PYTHON ?? "python3")} "$@"\n`,
    );
  }
  chmodSync(node, 0o700);
  chmodSync(npm, 0o700);
  if (options.brokenVenv) chmodSync(python, 0o700);
  return { PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
}

function withoutLsofPath(testRoot: string) {
  const env = stubToolchainEnv(testRoot);
  return { ...env, PATH: `${join(testRoot, "bin")}:/usr/bin:/bin` };
}

function prepareRunnableInstance(
  instance: string,
  port: string,
  appServer: string,
  workerPython: string,
  extraEnv: string[] = [],
  bundleServerSource = "",
) {
  const bundleId = `${"a".repeat(40)}-${"b".repeat(48)}`;
  const bundle = join(instance, "build", bundleId);
  markInstanceRoot(instance);
  mkdirSync(join(instance, "pids"), { recursive: true });
  mkdirSync(join(instance, "logs"), { recursive: true });
  mkdirSync(join(instance, "secrets"), { recursive: true });
  mkdirSync(join(bundle, "scripts"), { recursive: true });
  mkdirSync(join(bundle, "worker"), { recursive: true });
  mkdirSync(join(bundle, "venv", "bin"), { recursive: true });
  writeFileSync(join(bundle, "server.js"), bundleServerSource);
  writeFileSync(
    join(bundle, "scripts", "instance-run.sh"),
    readFileSync(RUN, "utf8"),
  );
  writeFileSync(
    join(bundle, "scripts", "instance-paths.sh"),
    readFileSync(INSTANCE_PATHS, "utf8"),
  );
  writeFileSync(
    join(bundle, "scripts", "run-worker-python.sh"),
    readFileSync(join(REPO_ROOT, "scripts", "run-worker-python.sh"), "utf8"),
  );
  writeFileSync(join(bundle, "worker", "main.py"), "");
  writeFileSync(
    join(bundle, "venv", "bin", "python3"),
    "#!/bin/sh\nif [ \"\${1:-}\" = \"-c\" ]; then exit 0; fi\nchild=\ntrap 'test -z \"$child\" || kill \"$child\" 2>/dev/null; exit 0' TERM INT\nsleep 1 & child=$!; wait \"$child\"\necho '[worker] ready with offline model fixture'\nwhile :; do sleep 30 & child=$!; wait \"$child\"; done\n",
  );
  chmodSync(join(bundle, "venv", "bin", "python3"), 0o700);
  writeFileSync(
    join(bundle, "venv", "bin", "fixture-tool"),
    `#!${bundle}/venv/bin/python3\n`,
  );
  chmodSync(join(bundle, "venv", "bin", "fixture-tool"), 0o700);
  const manifest = [
    "server.js",
    "scripts/instance-run.sh",
    "scripts/instance-paths.sh",
    "scripts/run-worker-python.sh",
    "worker/main.py",
  ]
    .map((relative) => {
      const checksum = createHash("sha256")
        .update(readFileSync(join(bundle, relative)))
        .digest("hex");
      return `${checksum} ${relative}`;
    })
    .join("\n");
  writeFileSync(join(bundle, "bundle.sha256"), `${manifest}\n`);
  writeFileSync(join(instance, "secrets", "auth.secret"), "auth");
  writeFileSync(join(instance, "secrets", "engine.secret"), "engine");
  writeFileSync(
    join(instance, "app.env"),
    [
      `PORT=${port}`,
      "HOSTNAME=127.0.0.1",
      `SUPERSCRIBER_ACTIVATION_ID=${bundleId}`,
      `SUPERSCRIBER_APP_BUNDLE=${shellQuote(bundle)}`,
      `SUPERSCRIBER_WORKER_VENV=${shellQuote(join(bundle, "venv"))}`,
      "SUPERSCRIBER_INSTANCE_TEST_MODE=1",
      `SUPERSCRIBER_TEST_APP_SERVER=${shellQuote(appServer)}`,
      `SUPERSCRIBER_TEST_WORKER_PYTHON=${shellQuote(workerPython)}`,
      "SUPERSCRIBER_ENGINE_MODE=internal",
      ...extraEnv,
      "",
    ].join("\n"),
  );
}

function activationIdFrom(instance: string) {
  const match = readFileSync(join(instance, "app.env"), "utf8").match(
    /^SUPERSCRIBER_ACTIVATION_ID=([0-9a-f]{40}-[0-9a-f]{48})$/m,
  );
  if (!match) throw new Error("missing activation id");
  return match[1];
}

function markInstanceRoot(instance: string) {
  mkdirSync(instance, { recursive: true });
  writeFileSync(
    join(instance, ".superscriber-instance"),
    "superscriber-local-instance-v1\ncreated_at=test\n",
  );
}

function writeModelTier(modelDir: string, vocabulary: "txt" | "json") {
  writeFileSync(join(modelDir, "model.bin"), "model");
  writeFileSync(join(modelDir, "config.json"), "{}");
  writeFileSync(join(modelDir, "tokenizer.json"), "{}");
  writeFileSync(join(modelDir, `vocabulary.${vocabulary}`), "vocabulary");
}

function prepareWorkingVenv(instance: string) {
  const bin = join(instance, "venv", "bin");
  mkdirSync(bin, { recursive: true });
  const python = join(bin, "python3");
  writeFileSync(python, "#!/bin/sh\nexit 0\n");
  chmodSync(python, 0o700);
}

function prepareBootstrapVenv(instance: string, ready: boolean) {
  writeBootstrapWorkerPython(join(instance, "venv"), ready);
}

function prepareActiveBundleVenv(instance: string, ready: boolean) {
  writeBootstrapWorkerPython(
    join(instance, "build", activationIdFrom(instance), "venv"),
    ready,
  );
}

function writeBootstrapWorkerPython(venv: string, ready: boolean) {
  const bin = join(venv, "bin");
  mkdirSync(bin, { recursive: true });
  const python = join(bin, "python3");
  writeFileSync(
    python,
    ready
      ? "#!/bin/sh\nif [ \"${1:-}\" = \"-c\" ]; then exit 0; fi\nsleep 1\necho '[worker] ready with offline model fixture'\ntrap 'kill \"$child\" 2>/dev/null; exit 0' TERM INT\nwhile :; do sleep 30 & child=$!; wait \"$child\"; done\n"
      : "#!/bin/sh\nif [ \"${1:-}\" = \"-c\" ]; then exit 0; fi\nsleep 1\necho '[worker] startup failed: fixture' >&2\nexit 1\n",
  );
  chmodSync(python, 0o700);
}

function readyWorkerScript() {
  return "#!/bin/sh\nchild=\ntrap 'test -z \"$child\" || kill \"$child\" 2>/dev/null; exit 0' TERM INT\nsleep 1 & child=$!; wait \"$child\"\necho '[worker] ready with offline model fixture'\nwhile :; do sleep 30 & child=$!; wait \"$child\"; done\n";
}

async function waitForCondition(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("condition did not become true before timeout");
}
