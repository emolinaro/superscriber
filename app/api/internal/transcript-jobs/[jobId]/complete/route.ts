import { NextResponse } from "next/server";
import { TranscriptJob, TranscriptSegment } from "@/domain/models";
import { completeTranscriptJob } from "@/server/orchestration/internal-queue";
import { requireOrchestrationAuthorization } from "@/server/orchestration/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseSegments(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .map((segment, index) => {
      if (!segment || typeof segment !== "object") {
        return null;
      }

      const candidate = segment as Partial<TranscriptSegment>;
      const startMs = parseNumber(candidate.startMs) ?? 0;
      const endMs = parseNumber(candidate.endMs) ?? startMs;

      return {
        id: parseString(candidate.id) || `segment-${index}`,
        speakerLabel: parseString(candidate.speakerLabel) || `Speaker ${index + 1}`,
        startMs,
        endMs,
        text: parseString(candidate.text),
        confidence: parseNumber(candidate.confidence) ?? 0.8,
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const unauthorized = requireOrchestrationAuthorization(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { jobId } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const workerId = parseString(body.workerId);
    const summary = parseString(body.summary);
    const segments = parseSegments(body.segments);

    if (!workerId || !summary || !segments || segments.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "workerId, summary, and at least one transcript segment are required.",
        },
        { status: 400 },
      );
    }

    const diarizationStatus = parseString(body.diarizationStatus) as
      | TranscriptJob["diarizationStatus"]
      | "";
    const snapshot = completeTranscriptJob({
      jobId,
      workerId,
      summary,
      segments,
      diarizationStatus: diarizationStatus || undefined,
    });

    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Job completion failed.",
      },
      { status: 400 },
    );
  }
}
