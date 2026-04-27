import { Recording, TranscriptSegment } from "@/domain/models";

const TRANSCRIPT_LIBRARY: Record<string, string[]> = {
  english: [
    "Thank you for taking the time to speak with us today.",
    "The main concern raised in this interview is the time required to coordinate follow-up actions.",
    "We also need to protect the identifiers mentioned during the conversation.",
    "Please confirm the next review step before this transcript is approved.",
  ],
  danish: [
    "Tak fordi du tager dig tid til at tale med os i dag.",
    "Det vigtigste tema i interviewet er opfølgning og koordinering.",
    "Vi skal samtidig beskytte de personoplysninger, der bliver nævnt.",
    "Bekræft venligst næste trin, før transskriptionen godkendes.",
  ],
  german: [
    "Vielen Dank, dass Sie sich heute Zeit für dieses Gespräch nehmen.",
    "Das Hauptthema im Interview ist die Koordination der weiteren Schritte.",
    "Wir müssen dabei besonders auf die erwähnten personenbezogenen Daten achten.",
    "Bitte bestätigen Sie den nächsten Prüfschritt vor der Freigabe.",
  ],
};

function libraryForLanguage(languageHint: string) {
  const normalized = languageHint.trim().toLowerCase();
  if (normalized.startsWith("da")) return TRANSCRIPT_LIBRARY.danish;
  if (normalized.startsWith("de")) return TRANSCRIPT_LIBRARY.german;
  return TRANSCRIPT_LIBRARY.english;
}

export function buildMockTranscript(recording: Recording): TranscriptSegment[] {
  const lines = libraryForLanguage(recording.languageHint);

  return lines.map((text, index) => ({
    id: `${recording.id}-segment-${index + 1}`,
    speakerLabel: index % 2 === 0 ? "Speaker A" : "Speaker B",
    startMs: index * 17_000,
    endMs: index * 17_000 + 15_000,
    text,
    confidence: index === 2 ? 0.86 : 0.93,
  }));
}

