import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  buildApprovedTranscriptExport,
  type ApprovedTranscriptExportRecording,
  type ApprovedTranscriptExportRevision,
} from "@/server/transcript-export";

const recording: ApprovedTranscriptExportRecording = {
  id: "rec-1",
  title: "Quarterly Review / Demo",
  source: "upload",
  languageHint: "en",
};

const revision: ApprovedTranscriptExportRevision = {
  id: "rev-1",
  version: 3,
  state: "approved",
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

async function readDocxDocumentXml(body: Uint8Array) {
  const archive = await JSZip.loadAsync(body);
  const documentXml = archive.file("word/document.xml");

  if (!documentXml) {
    throw new Error("Missing DOCX document.xml payload.");
  }

  return documentXml.async("string");
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

  it("formats Markdown with heading, metadata, and per-segment speaker/timings", async () => {
    const md = await buildApprovedTranscriptExport({
      format: "md",
      recording,
      revision,
    });

    expect(md.contentType).toBe("text/markdown; charset=utf-8");
    const text = decodeBody(md.body);
    expect(text.startsWith(`# ${recording.title}`)).toBe(true);
    expect(text).toContain(`- Revision: ${revision.version}`);
    expect(text).toContain(`- Approved: ${revision.approvedAt}`);
    expect(text).toContain("**Speaker 1** (00:00:01.234 - 00:00:05.678)");
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

  it("neutralizes spreadsheet formula-like CSV and TSV cells", async () => {
    const dangerousRevision: ApprovedTranscriptExportRevision = {
      ...revision,
      segments: [
        {
          id: "seg-dangerous",
          speakerLabel: "=cmd|' /C calc'!A0",
          startMs: 0,
          endMs: 1000,
          text: "  +SUM(1,2)",
          confidence: 0.5,
        },
        {
          id: "seg-dangerous-2",
          speakerLabel: "@malicious",
          startMs: 1000,
          endMs: 2000,
          text: "\t-HYPERLINK(\"https://example.com\")",
          confidence: 0.4,
        },
      ],
    };

    const csv = await buildApprovedTranscriptExport({
      format: "csv",
      recording,
      revision: dangerousRevision,
    });
    const tsv = await buildApprovedTranscriptExport({
      format: "tsv",
      recording,
      revision: dangerousRevision,
    });

    expect(decodeBody(csv.body)).toContain(
      `"seg-dangerous","'=cmd|' /C calc'!A0",0,1000,"'  +SUM(1,2)",0.5`,
    );
    expect(decodeBody(csv.body)).toContain(
      `"seg-dangerous-2","'@malicious",1000,2000,"'\t-HYPERLINK(""https://example.com"")",0.4`,
    );

    expect(decodeBody(tsv.body)).toContain(
      `"seg-dangerous"\t"'=cmd|' /C calc'!A0"\t0\t1000\t"'  +SUM(1,2)"\t0.5`,
    );
    expect(decodeBody(tsv.body)).toContain(
      `"seg-dangerous-2"\t"'@malicious"\t1000\t2000\t"'\t-HYPERLINK(""https://example.com"")"\t0.4`,
    );
  });

  it("builds a DOCX payload with ordered transcript content, speakers, and timestamps", async () => {
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

    const documentXml = await readDocxDocumentXml(docx.body);
    expect(documentXml).toContain("Quarterly Review / Demo");
    expect(documentXml).toContain("Revision 3");
    expect(documentXml).toContain("Speaker 1 ");
    expect(documentXml).toContain("00:00:01.234 - 00:00:05.678 Hello, &quot;team&quot;");
    expect(documentXml).toContain("Speaker\t2 ");
    expect(documentXml).toContain("00:01:02.000 - 01:01:01.000 Line one");
    expect(documentXml).toContain("Line two");

    const speakerOneIndex = documentXml.indexOf("Speaker 1 ");
    const speakerTwoIndex = documentXml.indexOf("Speaker\t2 ");
    expect(speakerOneIndex).toBeGreaterThan(-1);
    expect(speakerTwoIndex).toBeGreaterThan(speakerOneIndex);
  });
});
