# Speaker diarization (vendored pyannote bundle)

Superscriber attributes transcript segments to speakers locally with the
pinned pyannote **speaker-diarization-3.1** bundle (captain engine ruling,
2026-08-20, option A). The runtime never talks to the network for this on
any lane: the model bytes live in the same model cache as the
faster-whisper tiers, and the worker rewrites the pipeline config's model
references to those local checkpoints before instantiation, so pyannote's
local-path `Model.from_pretrained` bypasses the Hub entirely. Inside the
container (where `SUPERSCRIBER_TRANSCRIBE_OFFLINE=1` is the default) the
worker additionally exports `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`;
on host lanes that flag is normally unset and the checkpoint substitution
alone is what guarantees the zero-network behavior.

## Torch wheel selection (platform- and residence-aware)

The pinned `torch==2.8.0`/`torchaudio==2.8.0` pair installs through a
self-classifying dependency picker, per captain context corr=5b5415f96245d0fe
and directive corr=0688a345e73914a8: the installer detects host hardware -
OS + arch AND CUDA residence (NVIDIA) - at install time and picks the right
wheel variant automatically. CPU lanes stay CPU, CUDA-capable runtimes get
their CUDA wheel, macOS keeps its CPU/MPS build, and anything unrecognised
falls back to CPU wheels with a printed notice. The operator never names a
device: there is no manual `--device`/`--backend`-style toggle. A `plan:`
line naming the variant, source, and detected hardware prints before any
download. Wheels come from the pinned PyTorch index
(`https://download.pytorch.org/whl/<variant>`); the `cuXXX` indexes
self-mirror the `nvidia-*` runtime dependencies.

Callpath: `scripts/bootstrap-local.sh` installs
`worker/requirements.txt` (the always-on faster-whisper base) and then
`scripts/install-worker-torch-wheels.sh <venv-dir>`. The picker detects
the host, prints the plan line, installs and verifies the pinned pair, and
installs `worker/requirements-diarization.txt` (pyannote.audio +
matplotlib) - or, where no usable wheel exists, prints a notice and skips
the entire diarization stack with exit 0.

| OS | Arch | CUDA residence (NVIDIA) | Variant | Wheel index |
|---|---|---|---|---|
| macOS | arm64 | n/a | `pypi` | default PyPI (the only published macOS 2.8.0 wheels; CPU/MPS builds, arm64 only) |
| macOS | x86_64 | n/a | `skip` | none - no macOS x86_64 2.8.0 wheel exists, so the diarization stack is not installed (notice printed, exit 0) |
| Linux | x86_64 | none or driver CUDA < 12.6 | `cpu` | `download.pytorch.org/whl/cpu` |
| Linux | x86_64 | driver CUDA >= 12.6 / 12.8 / 12.9 | `cu126` / `cu128` / `cu129` | `download.pytorch.org/whl/<variant>` |
| Linux | aarch64 | JetPack wheels out of scope | `pypi` | default PyPI (CPU builds) |

On Intel macOS the picker prints a notice naming the skipped stack
(`torch`/`torchaudio`/`pyannote.audio`/`matplotlib`) and the bootstrap
succeeds with the faster-whisper CPU path only: transcription is
unaffected, and every job reports `diarizationStatus=degraded` -
diarization never breaks a job or an install.

An NVIDIA driver reporting CUDA below 12.6 (the torch 2.8 wheel floor)
prints a notice and falls back to CPU wheels so the box keeps diarizing;
upgrade the driver and the next install self-classifies onto the CUDA wheel
- no flag needed. The appliance container image pins the `cpu` variant
directly in the `Dockerfile` and stays CUDA-free.

The picker is orthogonal to checkpoint loading: torch 2.8 defaults
`weights_only=True` in every variant, and the worker allowlists the pinned
checkpoints' `torch.torch_version.TorchVersion` global in-process before
instantiating the pipeline (the 2026-08-20 fix for "Weights only load
failed ... add_safe_globals"). That holds equally for CPU and CUDA wheels.

## What gets vendored

| Part | Repository | Revision (commit SHA) | Files |
|---|---|---|---|
| Pipeline config | `pyannote/speaker-diarization-3.1` | `84fd25912480287da0247647c3d2b4853cb3ee5d` | `config.yaml` |
| Segmentation | `pyannote/segmentation-3.0` | `e66f3d3b9eb0873085418a7b813d3b369bf160bb` | `config.yaml`, `pytorch_model.bin` (~5.9 MB) |
| Speaker embedding | `pyannote/wespeaker-voxceleb-resnet34-LM` | `837717ddb9ff5507820346191109dc79c958d614` | `config.yaml`, `pytorch_model.bin` (~26.6 MB) |

The single source of truth (byte sizes included) is
`worker/diarization-bundle.json`; total ~31 MiB. Both installers - the TS
provisioning path and the image-build prefetcher - read that file.

Licensing: the pyannote-audio library is MIT; the two model repos declare the
MIT license with the gate text confirming they "will always remain
open-source". The only non-permissive step is the download gate itself.

## The one-time Hugging Face click-gate

`pyannote/segmentation-3.0` and `pyannote/speaker-diarization-3.1` are
HF-gated. Once per home:

1. Create a Hugging Face account and visit both model pages to accept the
   gate (plus `pyannote/wespeaker-voxceleb-resnet34-LM` if prompted - it is
   answerable publicly, so no acceptance needed).
2. Create a read-scoped access token at `https://hf.co/settings/tokens`.
3. Run provisioning with the token exported **for that run only**:

   ```sh
   SUPERSCRIBER_HUGGINGFACE_TOKEN=hf_... npx tsx scripts/provision-model-tier.ts --diarization
   ```

   or re-run `scripts/bootstrap-local.sh` with it exported. The token lives
   only in the process environment, travels on the pinned download requests,
   and is never written to disk or logs. Delete it afterwards if you want.

4. Verify: `npx tsx scripts/provision-model-tier.ts --verify-diarization`.

Already-provisioned caches make every re-run offline-capable (idempotent
skip).

## Container image

The pinned wheel set (`torch`, `torchaudio`, `pyannote.audio`, and their
dependency tree) is always installed in the image. Vendoring the gated model
bytes into the image is opt-in at build time:

```sh
docker build \
  --build-arg SUPERSCRIBER_PRELOAD_DIARIZATION=1 \
  --secret id=hf_token,env=SUPERSCRIBER_HUGGINGFACE_TOKEN .
```

The token travels via a BuildKit secret mount, so it is visible to that one
build step only and never lands in image history or the final image. With a
token supplied, a failed gated fetch fails the build (token means
required-and-verified); without one the prefetch logs a warning and the
image still builds, and speaker separation then simply degrades until the
bundle reaches the mounted model cache. Pass the token only when
prefetching, and prefer short-lived, read-scoped tokens.

## Runtime behavior

- With the bundle present, every completed transcription carries
  `diarizationStatus=available` and its segments carry real speaker labels
  ("Speaker 1", "Speaker 2", ... in first-appearance order). The governed
  batch speaker rename (Rename speaker... above the transcript) merges them
  like any other label.
- Without it (or on any engine error), the job completes exactly as before:
  one "Speaker 1" label and `diarizationStatus=degraded`. Diarization never
  fails a job.
- Set `SUPERSCRIBER_DIARIZATION_ENABLED=0` in the worker environment to
  disable attribution entirely even with the bundle present.
