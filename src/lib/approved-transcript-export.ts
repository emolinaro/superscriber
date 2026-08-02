const APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUP_DEFINITIONS = [
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
] as const;

export const APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS =
  APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUP_DEFINITIONS;

export type ApprovedTranscriptExportFormatGroup =
  (typeof APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS)[number];

export type ApprovedTranscriptExportFormat =
  ApprovedTranscriptExportFormatGroup["formats"][number];

export type ApprovedTranscriptExportFormatDefinition = {
  id: ApprovedTranscriptExportFormat;
  groupId: ApprovedTranscriptExportFormatGroup["id"];
  groupLabel: ApprovedTranscriptExportFormatGroup["label"];
};

export const APPROVED_TRANSCRIPT_EXPORT_FORMATS: readonly ApprovedTranscriptExportFormatDefinition[] =
  APPROVED_TRANSCRIPT_EXPORT_FORMAT_GROUPS.flatMap((group) =>
    group.formats.map((format) => ({
      id: format,
      groupId: group.id,
      groupLabel: group.label,
    })),
  );

const APPROVED_TRANSCRIPT_EXPORT_FORMAT_SET = new Set<ApprovedTranscriptExportFormat>(
  APPROVED_TRANSCRIPT_EXPORT_FORMATS.map((entry) => entry.id),
);

export function parseApprovedTranscriptExportFormat(value: string) {
  if (APPROVED_TRANSCRIPT_EXPORT_FORMAT_SET.has(value as ApprovedTranscriptExportFormat)) {
    return value as ApprovedTranscriptExportFormat;
  }

  return null;
}

export function buildApprovedTranscriptExportUrl(
  baseUrl: string,
  format: ApprovedTranscriptExportFormat,
  actionModeId?: string | null,
) {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(baseUrl);
  const url = isAbsoluteUrl
    ? new URL(baseUrl)
    : new URL(baseUrl, "https://approved-transcript-export.local");

  url.searchParams.set("format", format);

  if (actionModeId) {
    url.searchParams.set("actionModeId", actionModeId);
  }

  if (isAbsoluteUrl) {
    return url.toString();
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
