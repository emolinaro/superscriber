import { NextResponse } from "next/server";
import {
  DiarizationStatus,
  IntegrityState,
  TranscriptSegment,
  TranscriptJobState,
} from "@/domain/models";
import { getOrchestrationConfig } from "@/server/orchestration/config";
import {
  applyOrchestrationWebhookUpdate,
  OrchestrationWebhookPayload,
} from "@/server/orchestration/service";
import { withState } from "@/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseSegments(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
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
        id: parseString(candidate.id) ?? `segment-${index}`,
        speakerLabel: parseString(candidate.speakerLabel) ?? `Speaker ${index + 1}`,
        startMs,
        endMs,
        text: parseString(candidate.text) ?? "",
        confidence: parseNumber(candidate.confidence) ?? 0.8,
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

function parsePayload(input: unknown): OrchestrationWebhookPayload {
  if (!input || typeof input !== "object") {
    throw new Error("JSON payload must be an object.");
  }

  const body = input as Record<string, unknown>;
  const recordingId = parseString(body.recordingId);
  if (!recordingId) {
    throw new Error("recordingId is required.");
  }

  const payload: OrchestrationWebhookPayload = {
    recordingId,
    eventAt: parseString(body.eventAt) ?? undefined,
  };

  if (body.ingestionSession && typeof body.ingestionSession === "object") {
    const ingestion = body.ingestionSession as Record<string, unknown>;
    payload.ingestionSession = {
      state: parseString(ingestion.state) as IntegrityState | undefined,
      verificationSummary: parseString(ingestion.verificationSummary),
      lastError: parseString(ingestion.lastError),
      bytesReceived: parseNumber(ingestion.bytesReceived),
      bytesExpected: parseNumber(ingestion.bytesExpected),
      resumeToken: parseString(ingestion.resumeToken),
    };
  }

  if (body.transcriptJob && typeof body.transcriptJob === "object") {
    const transcriptJob = body.transcriptJob as Record<string, unknown>;
    payload.transcriptJob = {
      state: parseString(transcriptJob.state) as TranscriptJobState | undefined,
      progressPercent: parseNumber(transcriptJob.progressPercent),
      etaSeconds: parseNumber(transcriptJob.etaSeconds),
      diarizationStatus:
        (parseString(transcriptJob.diarizationStatus) as DiarizationStatus | undefined) ??
        undefined,
      lastError: parseString(transcriptJob.lastError),
      summary: parseString(transcriptJob.summary),
    };
  }

  if (body.transcript && typeof body.transcript === "object") {
    const transcript = body.transcript as Record<string, unknown>;
    payload.transcript = {
      summary: parseString(transcript.summary),
      segments: parseSegments(transcript.segments),
    };
  }

  return payload;
}

export async function POST(request: Request) {
  const config = getOrchestrationConfig();
  if (config.sharedSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${config.sharedSecret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  try {
    const payload = parsePayload(await request.json());
    withState((state) => {
      applyOrchestrationWebhookUpdate(state, payload);
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Webhook update failed.",
      },
      { status: 400 },
    );
  }
}
