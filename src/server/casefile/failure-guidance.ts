// Guided failure surface (mel-bins-mismatch / error-choreography): worker
// failures carry a stable, operator-greppable class slug. The casefile turns
// that slug into a plain-language card (cause + recovery action) for every
// viewer, and keeps the raw engine diagnostic for admins only. Copy lives
// here - one authoritative place - so the worker never dictates UI text.
//
// Worker-side class names: worker/main.py (MEL_SHAPE_ERROR_CLASS etc.). Keep
// this map's keys in sync with those constants.

export type TranscriptFailureGuidance = {
  /** Plain-language cause label shown on the reviewer-facing failure card. */
  causeLabel: string;
  /** Recovery action hint shown on the failure card. */
  actionHint: string;
};

const DEFAULT_GUIDANCE: TranscriptFailureGuidance = {
  causeLabel: "Transcription failed.",
  actionHint: "Delete this recording and upload it again.",
};

const GUIDANCE_BY_CLASS: Record<string, TranscriptFailureGuidance> = {
  "mel-shape-mismatch": {
    causeLabel:
      "Transcription failed - the speech model involved does not match its audio configuration (model/config mismatch).",
    actionHint: "Delete this recording and upload it again.",
  },
  "media-missing": {
    causeLabel:
      "Transcription failed because the stored media file could not be found.",
    actionHint: "Delete this recording and upload it again.",
  },
  "worker-internal-error": {
    causeLabel: "Transcription failed inside the transcription engine.",
    actionHint: "Delete this recording and upload it again.",
  },
};

export type TranscriptFailureCard = {
  /** Stable slug the user quotes to the operator (e.g. "mel-shape-mismatch"). */
  errorClass: string;
  causeLabel: string;
  actionHint: string;
  /** Ops-only diagnostic; populated exclusively for admins. */
  technicalDetail: string | null;
};

export function transcriptFailureCard(params: {
  errorClass: string | null;
  technicalDetail: string | null;
  isAdmin: boolean;
}): TranscriptFailureCard | null {
  const errorClass = params.errorClass;
  if (!errorClass) {
    return null;
  }

  const guidance = GUIDANCE_BY_CLASS[errorClass] ?? DEFAULT_GUIDANCE;
  return {
    errorClass,
    causeLabel: guidance.causeLabel,
    actionHint: guidance.actionHint,
    technicalDetail: params.isAdmin ? (params.technicalDetail ?? null) : null,
  };
}
