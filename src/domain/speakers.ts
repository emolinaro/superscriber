import type { TranscriptSegment } from "@/domain/models";
import { CasefileCommandError } from "@/server/casefile/errors";

export const SPEAKER_NAME_MAX_LENGTH = 80;

export type SpeakerCount = {
  label: string;
  segmentCount: number;
};

export type SpeakerRenamePlan = {
  fromSpeaker: string;
  toSpeaker: string;
  /** Segments currently attributed to `fromSpeaker` that will move. */
  renamedSegmentCount: number;
  /** Segments already attributed to `toSpeaker` (merge target > 0). */
  existingTargetSegmentCount: number;
  mergesWithExisting: boolean;
  segmentIds: string[];
};

export function validateSpeakerName(value: string, field: string): string {
  const name = value.trim();

  if (!name) {
    throw new CasefileCommandError("VALIDATION_ERROR", "Enter a speaker name.", {
      [field]: "Enter a speaker name.",
    });
  }

  if (name.length > SPEAKER_NAME_MAX_LENGTH) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      `Speaker names are limited to ${SPEAKER_NAME_MAX_LENGTH} characters.`,
      { [field]: `Speaker names are limited to ${SPEAKER_NAME_MAX_LENGTH} characters.` },
    );
  }

  return name;
}

/** Unique speaker labels in first-appearance order with segment counts. */
export function listSpeakers(segments: TranscriptSegment[]): SpeakerCount[] {
  const counts = new Map<string, number>();

  for (const segment of segments) {
    counts.set(segment.speakerLabel, (counts.get(segment.speakerLabel) ?? 0) + 1);
  }

  return [...counts.entries()].map(([label, segmentCount]) => ({ label, segmentCount }));
}

export function planSpeakerRename(
  segments: TranscriptSegment[],
  fromSpeaker: string,
  toSpeaker: string,
): SpeakerRenamePlan {
  const from = validateSpeakerName(fromSpeaker, "fromSpeaker");
  const to = validateSpeakerName(toSpeaker, "toSpeaker");

  if (from === to) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      "Choose a speaker name different from the current one.",
      { toSpeaker: "Choose a speaker name different from the current one." },
    );
  }

  const moving = segments.filter((segment) => segment.speakerLabel === from);
  if (moving.length === 0) {
    throw new CasefileCommandError(
      "VALIDATION_ERROR",
      `No segments are attributed to "${from}".`,
      { fromSpeaker: `No segments are attributed to "${from}".` },
    );
  }

  const existingTargetSegmentCount = segments.filter(
    (segment) => segment.speakerLabel === to,
  ).length;

  return {
    fromSpeaker: from,
    toSpeaker: to,
    renamedSegmentCount: moving.length,
    existingTargetSegmentCount,
    mergesWithExisting: existingTargetSegmentCount > 0,
    segmentIds: moving.map((segment) => segment.id),
  };
}

export function applySpeakerRename(
  segments: TranscriptSegment[],
  fromSpeaker: string,
  toSpeaker: string,
): TranscriptSegment[] {
  return segments.map((segment) =>
    segment.speakerLabel === fromSpeaker ? { ...segment, speakerLabel: toSpeaker } : segment,
  );
}

function segmentWord(count: number) {
  return count === 1 ? "segment" : "segments";
}

/**
 * Batch summary voice used by the pre-commit dialog, the post-rename notice,
 * and the audit detail: rename first, then the merge clause when the target
 * name already exists in the transcript.
 */
export function describeSpeakerRename(plan: SpeakerRenamePlan): string {
  const base = `Renamed "${plan.fromSpeaker}" to "${plan.toSpeaker}" across ${plan.renamedSegmentCount} ${segmentWord(plan.renamedSegmentCount)}.`;

  if (!plan.mergesWithExisting) {
    return base;
  }

  return `${base} Merged with existing "${plan.toSpeaker}" (${plan.existingTargetSegmentCount} ${segmentWord(plan.existingTargetSegmentCount)}).`;
}
