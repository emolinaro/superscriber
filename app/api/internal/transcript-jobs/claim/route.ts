import { NextResponse } from "next/server";
import { claimAvailableTranscriptJob } from "@/server/orchestration/internal-queue";
import { requireOrchestrationAuthorization } from "@/server/orchestration/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function POST(request: Request) {
  const unauthorized = requireOrchestrationAuthorization(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const workerId = parseString(body.workerId);
    if (!workerId) {
      return NextResponse.json(
        { ok: false, error: "workerId is required." },
        { status: 400 },
      );
    }

    const staleAfterMs = parseNumber(body.staleAfterMs) ?? undefined;
    const job = claimAvailableTranscriptJob({ workerId, staleAfterMs });
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Job claim failed.",
      },
      { status: 400 },
    );
  }
}
