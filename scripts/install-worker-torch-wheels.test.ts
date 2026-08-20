/**
 * install-worker-torch-wheels.sh self-classification tests (captain
 * directive corr=0688a345e73914a8): the installer picks the torch wheel
 * variant from detected host hardware - OS + arch AND CUDA residence - with
 * no operator device toggle, always printing a plan line before any
 * download and falling back to CPU wheels when nothing else is supported.
 *
 * Every test drives the real script end to end with a fixture venv whose
 * `pip` records its arguments (proving which wheel index would be invoked)
 * and whose `python3` answers the post-install verification; `uname` and
 * `nvidia-smi` are PATH-stubbed so the OS/arch/residence matrix is
 * simulated without touching the network. The matrix covers the
 * no-CUDA->CPU lane, NVIDIA->CUDA by driver (cu126/cu128/cu129), the
 * unknown->CPU fallback, macOS arm64, and the Intel-macOS diarization
 * skip.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = join(__dirname, "install-worker-torch-wheels.sh");

interface Host {
  os: "Darwin" | "Linux" | "FreeBSD" | string;
  arch?: string;
  /** Driver CUDA capability as printed by nvidia-smi, e.g. "12.8". */
  cuda?: string;
  /** torch version string the fixture python3 reports after "install". */
  reportedTorch: string;
}

async function fixtureHost(host: Host) {
  const dir = await mkdtemp(join(tmpdir(), "torch-picker-test-"));
  const stubBin = join(dir, "stub-bin");
  const venv = join(dir, "venv");
  await mkdir(stubBin, { recursive: true });
  await mkdir(join(venv, "bin"), { recursive: true });

  const stubs: Record<string, string> = {
    uname: `#!/bin/sh\nif [ "$1" = "-s" ]; then echo "${host.os}"; else echo "${
      host.arch ?? "x86_64"
    }"; fi\n`,
    ...(host.cuda
      ? {
          "nvidia-smi": `#!/bin/sh\necho 'NVIDIA-SMI 560.0  Driver Version: 560.0  CUDA Version: ${host.cuda} '\n`,
        }
      : {}),
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(stubBin, name);
    await writeFile(path, body);
    await chmod(path, 0o755);
  }

  const recordPath = join(dir, "pip-args.txt");
  await writeFile(
    join(venv, "bin", "pip"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${recordPath}"\n`,
  );
  await chmod(join(venv, "bin", "pip"), 0o755);

  await writeFile(
    join(venv, "bin", "python3"),
    `#!/bin/sh\nif [ "$1" = "-c" ]; then echo "${host.reportedTorch}"; exit 0; fi\nexit 1\n`,
  );
  await chmod(join(venv, "bin", "python3"), 0o755);

  return { dir, stubBin, venv, recordPath };
}

async function runPicker(host: Host) {
  const fixture = await fixtureHost(host);
  try {
    const result = await execFileAsync(
      SCRIPT,
      [fixture.venv],
      // PATH holds ONLY the stub dir plus system paths; a no-CUDA host has no
      // nvidia-smi stub, matching `command -v nvidia-smi` failing for real.
      { env: { ...process.env, PATH: `${fixture.stubBin}:/usr/bin:/bin:/usr/sbin:/sbin` } },
    );
    const pipRaw = await readFile(fixture.recordPath, "utf8").catch(() => "");
    // One recorded line per pip invocation: the pinned-pair install first,
    // the diarization requirements install second. An Intel-macOS skip
    // installs nothing, so the record file is absent entirely.
    const pipCalls = pipRaw.trim() ? pipRaw.trim().split("\n") : [];
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      pipCalls,
    };
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

const PLAN = /\[worker-torch\] plan: torch==2\.8\.0 \+ torchaudio==2\.8\.0 from (\S+)/;

describe("install-worker-torch-wheels.sh self-classification", () => {
  it("(a) self-selects CPU wheels on a host with no CUDA and prints the plan line", async () => {
    const { stdout, stderr, pipCalls } = await runPicker({
      os: "Linux",
      arch: "x86_64",
      reportedTorch: "2.8.0+cpu",
    });

    const plan = stdout.match(PLAN);
    expect(plan, `plan line missing from stdout: ${stdout}`).toBeTruthy();
    expect(plan?.[1]).toBe("https://download.pytorch.org/whl/cpu");
    expect(stdout).toContain("(variant=cpu; os=Linux arch=x86_64 cuda=none)");
    // The plan line is stdout-visible; install progress + verification follow.
    expect(stderr).toContain("installing torch==2.8.0 torchaudio==2.8.0 (variant=cpu)");
    expect(stderr).toContain("verified torch 2.8.0+cpu");
    // pip was driven against the CPU index with the pinned pair, then the
    // diarization stack (pyannote.audio + matplotlib) from its requirements file.
    expect(pipCalls).toHaveLength(2);
    expect(pipCalls[0]).toBe(
      "install --quiet --disable-pip-version-check --index-url https://download.pytorch.org/whl/cpu torch==2.8.0 torchaudio==2.8.0",
    );
    expect(pipCalls[1]).toContain("worker/requirements-diarization.txt");
  });

  it("(b) self-selects the NVIDIA CUDA wheel on a CUDA-capable host and prints the plan line", async () => {
    const { stdout, stderr, pipCalls } = await runPicker({
      os: "Linux",
      arch: "x86_64",
      cuda: "12.8",
      reportedTorch: "2.8.0+cu128",
    });

    const plan = stdout.match(PLAN);
    expect(plan, `plan line missing from stdout: ${stdout}`).toBeTruthy();
    expect(plan?.[1]).toBe("https://download.pytorch.org/whl/cu128");
    expect(stdout).toContain("(variant=cu128; os=Linux arch=x86_64 cuda=12.8)");
    expect(stderr).toContain("verified torch 2.8.0+cu128");
    expect(pipCalls[0]).toBe(
      "install --quiet --disable-pip-version-check --index-url https://download.pytorch.org/whl/cu128 torch==2.8.0 torchaudio==2.8.0",
    );
  });

  it("(b-cu129) a driver at or above CUDA 12.9 picks the newest cu129 wheel", async () => {
    const { stdout, stderr, pipCalls } = await runPicker({
      os: "Linux",
      arch: "x86_64",
      cuda: "13.0",
      reportedTorch: "2.8.0+cu129",
    });

    const plan = stdout.match(PLAN);
    expect(plan, `plan line missing from stdout: ${stdout}`).toBeTruthy();
    expect(plan?.[1]).toBe("https://download.pytorch.org/whl/cu129");
    expect(stdout).toContain("(variant=cu129; os=Linux arch=x86_64 cuda=13.0)");
    expect(stderr).toContain("verified torch 2.8.0+cu129");
    expect(pipCalls[0]).toBe(
      "install --quiet --disable-pip-version-check --index-url https://download.pytorch.org/whl/cu129 torch==2.8.0 torchaudio==2.8.0",
    );
  });

  it("(b-sub) an older-but-supported driver picks the newest matching CUDA wheel", async () => {
    const { stdout } = await runPicker({
      os: "Linux",
      arch: "x86_64",
      cuda: "12.6",
      reportedTorch: "2.8.0+cu126",
    });
    expect(stdout).toContain("(variant=cu126; os=Linux arch=x86_64 cuda=12.6)");
  });

  it("(c) falls back to safe CPU wheels on an unknown OS, with a printed notice", async () => {
    const { stdout, stderr, pipCalls } = await runPicker({
      os: "FreeBSD",
      arch: "x86_64",
      reportedTorch: "2.8.0+cpu",
    });

    const plan = stdout.match(PLAN);
    expect(plan).toBeTruthy();
    expect(plan?.[1]).toBe("https://download.pytorch.org/whl/cpu");
    expect(stdout).toContain("(variant=cpu; os=FreeBSD arch=x86_64 cuda=none)");
    expect(stderr).toContain(
      "notice: unrecognised OS 'FreeBSD'; falling back to CPU wheels",
    );
    expect(pipCalls[0]).toContain("--index-url https://download.pytorch.org/whl/cpu");
  });

  it("(c-sub) an NVIDIA driver below the wheel floor falls back to CPU with a notice", async () => {
    const { stdout, stderr } = await runPicker({
      os: "Linux",
      arch: "x86_64",
      cuda: "12.5",
      reportedTorch: "2.8.0+cpu",
    });
    expect(stdout).toContain("(variant=cpu;");
    expect(stderr).toContain(
      "notice: NVIDIA driver reports CUDA 12.5, below the torch 2.8.0 wheel floor (cu126); falling back to CPU wheels",
    );
  });

  it("self-selects the macOS CPU/MPS pair from the default PyPI index", async () => {
    const { stdout, stderr, pipCalls } = await runPicker({
      os: "Darwin",
      arch: "arm64",
      reportedTorch: "2.8.0",
    });

    const plan = stdout.match(PLAN);
    expect(plan?.[1]).toBe("PyPI"); // "PyPI (default index)"
    expect(stdout).toContain("(variant=pypi; os=Darwin arch=arm64 cuda=none)");
    expect(stderr).toContain("verified torch 2.8.0");
    expect(pipCalls[0]).toBe(
      "install --quiet --disable-pip-version-check torch==2.8.0 torchaudio==2.8.0",
    );
    expect(pipCalls[1]).toContain("worker/requirements-diarization.txt");
  });

  it("skips the diarization stack on Intel macOS with a notice and exits 0 without installing", async () => {
    const { stdout, stderr, pipCalls } = await runPicker({
      os: "Darwin",
      arch: "x86_64",
      reportedTorch: "2.8.0",
    });

    // Plan + notice are printed, the run succeeds, and pip never runs:
    // transcription keeps working via faster-whisper and jobs report
    // diarizationStatus=degraded (the never-break-a-job contract).
    expect(stdout).toContain("plan: skipping the diarization stack");
    expect(stdout).toContain("(variant=skip; os=Darwin arch=x86_64 cuda=none)");
    expect(stderr).toContain("no macOS x86_64 wheel exists for torch 2.8.0");
    expect(stderr).toContain("diarizationStatus=degraded");
    expect(pipCalls).toHaveLength(0);
  });

  it("never exposes an operator device toggle", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/--(device|backend)\b/);
    expect(source).not.toMatch(/SUPERSCRIBER_TORCH_VARIANT/);
  });
});

// (above, "PyPI" is the first word of "PyPI (default index)" in the plan line)
