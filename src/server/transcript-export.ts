import { Document, Packer, Paragraph, TextRun } from "docx";
import type { Recording, TranscriptRevision } from "@/domain/models";
import type { ApprovedTranscriptExportFormat } from "@/lib/approved-transcript-export";

type ExportRecording = Pick<
  Recording,
  "id" | "title" | "languageHint" | "source"
>;

type ExportRevision = Pick<
  TranscriptRevision,
  "id" | "version" | "state" | "summary" | "approvedAt" | "segments"
>;

export type TranscriptExportPayload = {
  contentType: string;
  body: Uint8Array;
};

function padTimestampPart(value: number, width: number) {
  return value.toString().padStart(width, "0");
}

export function formatCaptionTimestamp(
  milliseconds: number,
  format: Extract<ApprovedTranscriptExportFormat, "srt" | "vtt">,
) {
  const totalMilliseconds = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const remainderMilliseconds = totalMilliseconds % 1_000;
  const separator = format === "srt" ? "," : ".";

  return [
    padTimestampPart(hours, 2),
    padTimestampPart(minutes, 2),
    padTimestampPart(seconds, 2),
  ].join(":")
    + separator
    + padTimestampPart(remainderMilliseconds, 3);
}

export function escapeDelimitedField(value: string, delimiter: "," | "\t") {
  const escaped = value.replaceAll('"', '""');

  if (
    escaped.includes(delimiter) ||
    escaped.includes('"') ||
    escaped.includes("\n") ||
    escaped.includes("\r") ||
    escaped.includes("\t")
  ) {
    return `"${escaped}"`;
  }

  return `"${escaped}"`;
}

function createTextExport(recording: ExportRecording, revision: ExportRevision) {
  const lines = [
    `Title: ${recording.title}`,
    `Revision: ${revision.version}`,
    `Language: ${recording.languageHint}`,
    `Source: ${recording.source}`,
    "",
    ...revision.segments.map((segment) => {
      const start = formatCaptionTimestamp(segment.startMs, "vtt");
      const end = formatCaptionTimestamp(segment.endMs, "vtt");
      return `[${start} - ${end}] ${segment.speakerLabel}: ${segment.text}`;
    }),
  ];

  return {
    contentType: "text/plain; charset=utf-8",
    body: new TextEncoder().encode(lines.join("\n")),
  } satisfies TranscriptExportPayload;
}

function createCaptionExport(
  revision: ExportRevision,
  format: Extract<ApprovedTranscriptExportFormat, "srt" | "vtt">,
) {
  const blocks = revision.segments.map((segment, index) => {
    const start = formatCaptionTimestamp(segment.startMs, format);
    const end = formatCaptionTimestamp(segment.endMs, format);
    const lines =
      format === "srt"
        ? [String(index + 1), `${start} --> ${end}`, segment.text]
        : [`${start} --> ${end}`, segment.text];

    return lines.join("\n");
  });

  const body =
    format === "vtt"
      ? `WEBVTT\n\n${blocks.join("\n\n")}\n`
      : `${blocks.join("\n\n")}\n`;

  return {
    contentType:
      format === "srt" ? "application/x-subrip" : "text/vtt; charset=utf-8",
    body: new TextEncoder().encode(body),
  } satisfies TranscriptExportPayload;
}

function createDelimitedExport(
  revision: ExportRevision,
  delimiter: "," | "\t",
  contentType: string,
) {
  const header = [
    "segmentId",
    "speakerLabel",
    "startMs",
    "endMs",
    "text",
    "confidence",
  ].map((field) => escapeDelimitedField(field, delimiter));

  const rows = revision.segments.map((segment) =>
    [
      escapeDelimitedField(segment.id, delimiter),
      escapeDelimitedField(segment.speakerLabel, delimiter),
      segment.startMs.toString(),
      segment.endMs.toString(),
      escapeDelimitedField(segment.text, delimiter),
      segment.confidence.toString(),
    ].join(delimiter),
  );

  return {
    contentType,
    body: new TextEncoder().encode([header.join(delimiter), ...rows].join("\n")),
  } satisfies TranscriptExportPayload;
}

function createJsonExport(recording: ExportRecording, revision: ExportRevision) {
  return {
    contentType: "application/json; charset=utf-8",
    body: new TextEncoder().encode(
      JSON.stringify({
        metadata: {
          recordingId: recording.id,
          title: recording.title,
          languageHint: recording.languageHint,
          source: recording.source,
          revisionId: revision.id,
          revisionVersion: revision.version,
          revisionState: revision.state,
          summary: revision.summary,
          approvedAt: revision.approvedAt,
        },
        segments: revision.segments.map((segment) => ({ ...segment })),
      }),
    ),
  } satisfies TranscriptExportPayload;
}

async function createDocxExport(
  recording: ExportRecording,
  revision: ExportRevision,
) {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: recording.title, bold: true })],
          }),
          new Paragraph(`Revision ${revision.version}`),
          new Paragraph(`Language: ${recording.languageHint}`),
          new Paragraph(`Source: ${recording.source}`),
          new Paragraph(""),
          ...revision.segments.map(
            (segment) =>
              new Paragraph({
                children: [
                  new TextRun({
                    text: `${segment.speakerLabel} `,
                    bold: true,
                  }),
                  new TextRun(
                    `${formatCaptionTimestamp(segment.startMs, "vtt")} - ${formatCaptionTimestamp(segment.endMs, "vtt")} ${segment.text}`,
                  ),
                ],
              }),
          ),
        ],
      },
    ],
  });

  return {
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: new Uint8Array(await Packer.toBuffer(document)),
  } satisfies TranscriptExportPayload;
}

export async function buildApprovedTranscriptExport(params: {
  format: ApprovedTranscriptExportFormat;
  recording: ExportRecording;
  revision: ExportRevision;
}): Promise<TranscriptExportPayload> {
  switch (params.format) {
    case "txt":
      return createTextExport(params.recording, params.revision);
    case "docx":
      return createDocxExport(params.recording, params.revision);
    case "srt":
    case "vtt":
      return createCaptionExport(params.revision, params.format);
    case "csv":
      return createDelimitedExport(
        params.revision,
        ",",
        "text/csv; charset=utf-8",
      );
    case "tsv":
      return createDelimitedExport(
        params.revision,
        "\t",
        "text/tab-separated-values; charset=utf-8",
      );
    case "json":
      return createJsonExport(params.recording, params.revision);
  }
}
