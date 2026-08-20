# Speaker diarization (vendored pyannote bundle)

Superscriber attributes transcript segments to speakers locally with the
pinned pyannote **speaker-diarization-3.1** bundle (captain engine ruling,
2026-08-20, option A). The runtime never talks to the network for this: the
model bytes live in the same model cache as the faster-whisper tiers and
load from local files only (the worker runs with `HF_HUB_OFFLINE=1`).

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
  --build-arg SUPERSCRIBER_HUGGINGFACE_TOKEN=hf_... .
```

Without a token the prefetch logs a warning and the image still builds;
speaker separation then simply degrades until the bundle reaches the mounted
model cache. Pass the token only when prefetching, and prefer short-lived,
read-scoped tokens.

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
