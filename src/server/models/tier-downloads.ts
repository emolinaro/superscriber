// model-tier-provisioning: pinned download sources for every faster-whisper
// tier the catalog can offer. Repositories come from faster-whisper's own
// _MODELS map (Systran/* plus the turbo model's current canonical repo), and
// every entry is pinned to an immutable commit SHA read from the Hugging Face
// API on 2026-08-11. sizeBytes is the exact sum of the pinned files' sizes at
// that revision; it drives the picker's size label and the pre-download disk
// space check.
//
// Note: faster-whisper's _MODELS names "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
// for the turbo tier; Hugging Face redirects that name to the canonical
// dropbox-dash repository below, which is what we pin.

export type TierDownloadSource = {
  repository: string;
  revision: string;
  files: string[];
  sizeBytes: number;
};

const SYSTRAN_V1_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"];
const SYSTRAN_V3_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.json"];

export const TIER_DOWNLOADS: Record<string, TierDownloadSource> = {
  "large-v3": {
    repository: "Systran/faster-whisper-large-v3",
    revision: "edaa852ec7e145841d8ffdb056a99866b5f0a478",
    files: SYSTRAN_V3_FILES,
    sizeBytes: 3_090_835_362,
  },
  "large-v3-turbo": {
    repository: "dropbox-dash/faster-whisper-large-v3-turbo",
    revision: "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
    files: SYSTRAN_V3_FILES,
    sizeBytes: 1_621_665_643,
  },
  "distil-large-v3": {
    repository: "Systran/faster-distil-whisper-large-v3",
    revision: "c3058b475261292e64a0412df1d2681c06260fab",
    files: SYSTRAN_V3_FILES,
    sizeBytes: 1_516_479_288,
  },
  "large-v2": {
    repository: "Systran/faster-whisper-large-v2",
    revision: "f0fe81560cb8b68660e564f55dd99207059c092e",
    files: SYSTRAN_V1_FILES,
    sizeBytes: 3_089_578_858,
  },
  "large-v1": {
    repository: "Systran/faster-whisper-large-v1",
    revision: "b07c8d4be0be90092aa01a29c975077acb8d15c9",
    files: SYSTRAN_V1_FILES,
    sizeBytes: 3_089_578_414,
  },
  medium: {
    repository: "Systran/faster-whisper-medium",
    revision: "08e178d48790749d25932bbc082711ddcfdfbc4f",
    files: SYSTRAN_V1_FILES,
    sizeBytes: 1_530_571_735,
  },
  small: {
    repository: "Systran/faster-whisper-small",
    revision: "536b0662742c02347bc0e980a01041f333bce120",
    files: SYSTRAN_V1_FILES,
    sizeBytes: 486_212_372,
  },
  base: {
    repository: "Systran/faster-whisper-base",
    revision: "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    files: SYSTRAN_V1_FILES,
    sizeBytes: 147_882_941,
  },
  tiny: {
    repository: "Systran/faster-whisper-tiny",
    revision: "d90ca5fe260221311c53c58e660288d3deb8d356",
    files: SYSTRAN_V1_FILES,
    sizeBytes: 78_203_619,
  },
};

export const HUGGINGFACE_DOWNLOAD_BASE_URL = "https://huggingface.co";

export function tierDownloadSource(tierId: string): TierDownloadSource {
  // The table is keyed by exactly the catalog tier ids (enforced by the
  // module tests), so a missing key IS the unknown-tier signal.
  const source = TIER_DOWNLOADS[tierId];
  if (!source) {
    throw new Error(`unknown model tier: ${tierId}`);
  }
  return source;
}

export function modelTierDownloadUrls(tierId: string): string[] {
  const source = tierDownloadSource(tierId);
  return source.files.map(
    (file) =>
      `${HUGGINGFACE_DOWNLOAD_BASE_URL}/${source.repository}/resolve/${source.revision}/${file}`,
  );
}
