import { describe, expect, it } from "vitest";
import type { Recording, TranscriptRevision } from "@/domain/models";
import { buildApprovedTranscriptExport } from "@/server/transcript-export";

const recording: Recording = {
  id: "rec-1",
  workspaceId: "workspace-1",
  title: "Quarterly Review / Demo",
  source: "upload",
  mediaKind: "audio",
  mimeType: "audio/mpeg",
  mediaPath: null,
  originalFileName: "quarterly-review.mp3",
  languageHint: "en",
  uploadedByRole: "reviewer",
  ingestionSessionId: null,
  transcriptJobId: null,
  integrityState: "verified",
  transcriptJobState: "completed",
  currentRevisionId: "rev-1",
  approvedRevisionId: "rev-1",
  pendingRevisionId: null,
  verificationSummary: "Verified.",
  createdAt: "2026-05-01T09:00:00.000Z",
  updatedAt: "2026-05-01T09:30:00.000Z",
  automationCursor: null,
};

const revision: TranscriptRevision = {
  id: "rev-1",
  recordingId: "rec-1",
  version: 3,
  state: "approved",
  basedOnRevisionId: "rev-0",
  createdByRole: "reviewer",
  createdAt: "2026-05-01T09:10:00.000Z",
  submittedAt: "2026-05-01T09:20:00.000Z",
  approvedAt: "2026-05-01T09:25:00.000Z",
  summary: "Approved export fixture.",
  segments: [
    {
      id: "seg-1",
      speakerLabel: "Speaker 1",
      startMs: 1234,
      endMs: 5678,
      text: 'Hello, "team"',
      confidence: 0.98,
    },
    {
      id: "seg-2",
      speakerLabel: "Speaker\t2",
      startMs: 62000,
      endMs: 3661000,
      text: "Line one\nLine two",
      confidence: 0.76,
    },
  ],
};

function decodeBody(body: Uint8Array) {
  return new TextDecoder().decode(body);
}

describe("approved transcript export formatter", () => {
  it("formats SRT and VTT timestamps with the expected separators and header", async () => {
    const srt = await buildApprovedTranscriptExport({
      format: "srt",
      recording,
      revision,
    });
    const vtt = await buildApprovedTranscriptExport({
      format: "vtt",
      recording,
      revision,
    });

    expect(srt.contentType).toBe("application/x-subrip");
    expect(decodeBody(srt.body)).toContain("00:00:01,234 --> 00:00:05,678");
    expect(decodeBody(srt.body)).toContain("00:01:02,000 --> 01:01:01,000");

    const vttText = decodeBody(vtt.body);
    expect(vtt.contentType).toBe("text/vtt; charset=utf-8");
    expect(vttText.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vttText).toContain("00:00:01.234 --> 00:00:05.678");
    expect(vttText).toContain("00:01:02.000 --> 01:01:01.000");
  });

  it("escapes CSV and TSV fields and keeps JSON metadata plus segment shape stable", async () => {
    const csv = await buildApprovedTranscriptExport({
      format: "csv",
      recording,
      revision,
    });
    const tsv = await buildApprovedTranscriptExport({
      format: "tsv",
      recording,
      revision,
    });
    const json = await buildApprovedTranscriptExport({
      format: "json",
      recording,
      revision,
    });

    expect(csv.contentType).toBe("text/csv; charset=utf-8");
    expect(decodeBody(csv.body)).toContain(
      '"seg-1","Speaker 1",1234,5678,"Hello, ""team""",0.98',
    );
    expect(decodeBody(csv.body)).toContain(
      '"seg-2","Speaker' + "\t" + '2",62000,3661000,"Line one\nLine two",0.76',
    );

    expect(tsv.contentType).toBe("text/tab-separated-values; charset=utf-8");
    expect(decodeBody(tsv.body)).toContain(
      '"seg-1"\t"Speaker 1"\t1234\t5678\t"Hello, ""team"""\t0.98',
    );
    expect(decodeBody(tsv.body)).toContain(
      '"seg-2"\t"Speaker' + "\t" + '2"\t62000\t3661000\t"Line one\nLine two"\t0.76',
    );

    expect(json.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(decodeBody(json.body))).toEqual({
      metadata: {
        recordingId: "rec-1",
        title: "Quarterly Review / Demo",
        languageHint: "en",
        source: "upload",
        revisionId: "rev-1",
        revisionVersion: 3,
        revisionState: "approved",
        summary: "Approved export fixture.",
        approvedAt: "2026-05-01T09:25:00.000Z",
      },
      segments: [
        {
          id: "seg-1",
          speakerLabel: "Speaker 1",
          startMs: 1234,
          endMs: 5678,
          text: 'Hello, "team"',
          confidence: 0.98,
        },
        {
          id: "seg-2",
          speakerLabel: "Speaker\t2",
          startMs: 62000,
          endMs: 3661000,
          text: "Line one\nLine two",
          confidence: 0.76,
        },
      ],
    });
  });

  it("builds a DOCX payload as binary bytes with the DOCX content type", async () => {
    const docx = await buildApprovedTranscriptExport({
      format: "docx",
      recording,
      revision,
    });

    expect(docx.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(docx.body).toBeInstanceOf(Uint8Array);
    expect(docx.body.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(docx.body).subarray(0, 2).toString("utf8")).toBe("PK");
  });
});
