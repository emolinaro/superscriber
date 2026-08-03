import { describe, expect, it } from "vitest";
import {
  APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS,
  APPROVED_TRANSCRIPT_EXPORT_FORMATS,
  buildApprovedTranscriptExportUrl,
  parseApprovedTranscriptExportFormat,
} from "@/lib/approved-transcript-export";

describe("approved transcript export registry", () => {
  it("parses supported formats and rejects unknown values", () => {
    expect(parseApprovedTranscriptExportFormat("docx")).toBe("docx");
    expect(parseApprovedTranscriptExportFormat("vtt")).toBe("vtt");
    expect(parseApprovedTranscriptExportFormat("json")).toBe("json");
    expect(parseApprovedTranscriptExportFormat("pdf")).toBeNull();
    expect(parseApprovedTranscriptExportFormat("DOCX")).toBeNull();
    expect(parseApprovedTranscriptExportFormat("")).toBeNull();
  });

  it("keeps the review-sheet group order stable", () => {
    expect(APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS).toEqual([
      {
        id: "document",
        label: "Document",
        formats: ["docx", "txt"],
      },
      {
        id: "captions",
        label: "Captions",
        formats: ["srt", "vtt"],
      },
      {
        id: "structured",
        label: "Structured",
        formats: ["csv", "tsv", "json"],
      },
    ]);

    expect(APPROVED_TRANSCRIPT_EXPORT_FORMATS.map((entry) => entry.id)).toEqual([
      "docx",
      "txt",
      "srt",
      "vtt",
      "csv",
      "tsv",
      "json",
    ]);
  });

  it("builds an export url without losing the base path", () => {
    expect(
      buildApprovedTranscriptExportUrl(
        "https://example.com/workspaces/demo/transcripts/123/export",
        "docx",
      ),
    ).toBe(
      "https://example.com/workspaces/demo/transcripts/123/export?format=docx",
    );

    expect(
      buildApprovedTranscriptExportUrl(
        "https://example.com/workspaces/demo/transcripts/123/export?download=1",
        "json",
        "mode-1",
      ),
    ).toBe(
      "https://example.com/workspaces/demo/transcripts/123/export?download=1&format=json&actionModeId=mode-1",
    );

    expect(
      buildApprovedTranscriptExportUrl(
        "/workspaces/demo/transcripts/123/export?download=1",
        "txt",
      ),
    ).toBe("/workspaces/demo/transcripts/123/export?download=1&format=txt");
  });
});
