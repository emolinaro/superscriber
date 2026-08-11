import { NextResponse } from "next/server";
import { TranscriptJob } from "@/domain/models";
import { heartbeatTranscriptJob } from "@/server/orchestration/internal-queue";
import { requireOrchestrationAuthorization } from "@/server/orchestration/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
    if (!workerId) {
      return NextResponse.json(
        { ok: false, error: "workerId is required." },
        { status: 400 },
      );
    }

    const candidateState = parseString(body.state);
    const state =
      candidateState === "running" || candidateState === "partial_result"
        ? (candidateState as Extract<TranscriptJob["state"], "running" | "partial_result">)
        : undefined;

    const snapshot = heartbeatTranscriptJob({
      jobId,
      workerId,
      state,
      progressPercent: parseNumber(body.progressPercent),
      etaSeconds: parseNumber(body.etaSeconds),
      diarizationStatus:
        candidateState === "partial_result"
          ? "degraded"
          : (parseString(body.diarizationStatus) as TranscriptJob["diarizationStatus"] | "") ||
            undefined,
      transcribedUntilMs: parseNumber(body.transcribedUntilMs),
      audioDurationMs: parseNumber(body.audioDurationMs),
      segmentsSeen: parseNumber(body.segmentsSeen),
    });

    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Job heartbeat failed.",
      },
      { status: 400 },
    );
  }
}
