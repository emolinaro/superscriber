import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/domain/models";
import {
  applySpeakerRename,
  describeSpeakerRename,
  listSpeakers,
  planSpeakerRename,
  SPEAKER_NAME_MAX_LENGTH,
} from "@/domain/speakers";
import { CasefileCommandError } from "@/server/casefile/errors";

function segment(id: string, speakerLabel: string): TranscriptSegment {
  return { id, speakerLabel, startMs: 0, endMs: 1_000, text: id, confidence: 0.9 };
}

const segments = [
  segment("seg-1", "Speaker A"),
  segment("seg-2", "Speaker B"),
  segment("seg-3", "Speaker A"),
  segment("seg-4", "Speaker B"),
  segment("seg-5", "Speaker C"),
];

describe("listSpeakers", () => {
  it("returns unique speakers in first-appearance order with counts", () => {
    expect(listSpeakers(segments)).toEqual([
      { label: "Speaker A", segmentCount: 2 },
      { label: "Speaker B", segmentCount: 2 },
      { label: "Speaker C", segmentCount: 1 },
    ]);
  });
});

describe("planSpeakerRename", () => {
  it("counts every segment attributed to the source speaker", () => {
    const plan = planSpeakerRename(segments, "Speaker B", "Dana");

    expect(plan).toMatchObject({
      fromSpeaker: "Speaker B",
      toSpeaker: "Dana",
      renamedSegmentCount: 2,
      existingTargetSegmentCount: 0,
      mergesWithExisting: false,
      segmentIds: ["seg-2", "seg-4"],
    });
  });

  it("marks a rename onto an existing speaker as a merge with the target count", () => {
    const plan = planSpeakerRename(segments, "Speaker B", "Speaker A");

    expect(plan.mergesWithExisting).toBe(true);
    expect(plan.existingTargetSegmentCount).toBe(2);
    expect(plan.renamedSegmentCount).toBe(2);
  });

  it("trims the target name before planning", () => {
    const plan = planSpeakerRename(segments, "Speaker C", "  Dana  ");
    expect(plan.toSpeaker).toBe("Dana");
  });

  it("rejects an empty target name", () => {
    expect(() => planSpeakerRename(segments, "Speaker A", "   ")).toThrowError(
      CasefileCommandError,
    );
  });

  it("rejects a target name longer than the speaker-name limit", () => {
    const tooLong = "x".repeat(SPEAKER_NAME_MAX_LENGTH + 1);
    expect(() => planSpeakerRename(segments, "Speaker A", tooLong)).toThrowError(
      CasefileCommandError,
    );
  });

  it("rejects renaming onto the same speaker", () => {
    expect(() => planSpeakerRename(segments, "Speaker A", "Speaker A")).toThrowError(
      CasefileCommandError,
    );
  });

  it("rejects a source speaker with no attributed segments", () => {
    expect(() => planSpeakerRename(segments, "Speaker Z", "Dana")).toThrowError(
      CasefileCommandError,
    );
  });

  it.each([
    ["surrounding whitespace", " Dana "],
    ["an over-length label", "x".repeat(SPEAKER_NAME_MAX_LENGTH + 1)],
  ])("renames an exact legacy source with %s onto a valid target", (_case, source) => {
    const legacySegments = [segment("legacy-1", source)];
    const plan = planSpeakerRename(legacySegments, source, "Dana");

    expect(plan).toMatchObject({
      fromSpeaker: source,
      toSpeaker: "Dana",
      renamedSegmentCount: 1,
      segmentIds: ["legacy-1"],
    });
    expect(applySpeakerRename(legacySegments, plan.fromSpeaker, plan.toSpeaker)).toEqual([
      expect.objectContaining({ speakerLabel: "Dana" }),
    ]);
  });
});

describe("applySpeakerRename", () => {
  it("rewrites only the source speaker labels and preserves segment shape", () => {
    const renamed = applySpeakerRename(segments, "Speaker B", "Dana");

    expect(renamed.map((entry) => entry.speakerLabel)).toEqual([
      "Speaker A",
      "Dana",
      "Speaker A",
      "Dana",
      "Speaker C",
    ]);
    expect(renamed.map((entry) => entry.id)).toEqual(segments.map((entry) => entry.id));
    expect(renamed).not.toBe(segments);
    expect(segments[1].speakerLabel).toBe("Speaker B");
  });
});

describe("describeSpeakerRename", () => {
  it("states the rename across the moved segment count", () => {
    const plan = planSpeakerRename(segments, "Speaker B", "Dana");
    expect(describeSpeakerRename(plan)).toBe(
      'Renamed "Speaker B" to "Dana" across 2 segments.',
    );
  });

  it("names the merge target when renaming onto an existing speaker", () => {
    const plan = planSpeakerRename(segments, "Speaker B", "Speaker A");
    expect(describeSpeakerRename(plan)).toBe(
      'Renamed "Speaker B" to "Speaker A" across 2 segments. Merged with existing "Speaker A" (2 segments).',
    );
  });

  it("uses singular wording for a one-segment rename", () => {
    const plan = planSpeakerRename(segments, "Speaker C", "Dana");
    expect(describeSpeakerRename(plan)).toBe(
      'Renamed "Speaker C" to "Dana" across 1 segment.',
    );
  });
});
