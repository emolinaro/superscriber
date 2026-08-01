import { describe, expect, it } from "vitest";
import { formatDateTimeIso, formatDateTimeUtc } from "@/lib/format";

describe("UTC date formatting", () => {
  it("formats explicit UTC labels and accessible ISO text", () => {
    expect(formatDateTimeUtc("2026-08-01T14:32:00.000Z")).toBe(
      "01 Aug 2026, 14:32 UTC",
    );
    expect(formatDateTimeIso("2026-08-01T14:32:00.000Z")).toBe(
      "2026-08-01T14:32:00.000Z",
    );
  });
});
